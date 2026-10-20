import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreFlushUnavailableError } from "./errors.js";
import type { FlusherHooks, FlusherPassReport } from "./flusher-protocol.js";
import { FLUSHER_CONNECTION_PRAGMAS } from "./pragmas.js";
import { EngineStore } from "./store.js";

const sqlite = await import("node:sqlite").catch(() => null);
const describeStore = sqlite ? describe : describe.skip;
let root: string;
const stores: EngineStore[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-checkpoint-"));
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
});

async function open(hooks: FlusherHooks = {}, log?: (line: string) => void) {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true, ...hooks },
    ...(log ? { log } : {}),
  });
  stores.push(store);
  store.transaction(() =>
    store.exec("CREATE TABLE checkpoint_test(id INTEGER PRIMARY KEY, body BLOB)"),
  );
  return store;
}

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("flusher did not progress");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function pass(store: EngineStore): Promise<FlusherPassReport> {
  return new Promise((resolve) => {
    const off = store.onSynced((_g, report) => {
      off();
      resolve(report);
    });
    store.flusherControl.tick();
  });
}

function write(store: EngineStore, id: number, bytes = 256 * 1024) {
  store.transaction(() =>
    store
      .prepare("INSERT OR REPLACE INTO checkpoint_test VALUES(?, ?)")
      .run(id, Buffer.alloc(bytes, id)),
  );
}

describeStore("flusher is the only serving checkpointer", () => {
  it("proves a barrier across WAL restart between its checkpoint and explicit sync", async () => {
    const buffer = new SharedArrayBuffer(8);
    const gate = new Int32Array(buffer);
    const store = await open({ checkpointGate: buffer });
    expect(FLUSHER_CONNECTION_PRAGMAS.checkpoint_fullfsync).toBe(1);
    await pass(store);
    write(store, 1);
    const before = readFileSync(store.paths.wal).subarray(16, 24); // WAL salt identifies reuse.
    const covered = store.flushed();
    Atomics.store(gate, 0, 1);
    const checkpointing = pass(store);
    try {
      await until(() => Atomics.load(gate, 0) === 2);
      // The flusher synchronized row 1's backfill. Row 2 reuses that WAL while
      // the worker is paused BEFORE its explicit WAL barrier.
      write(store, 2);
      expect(readFileSync(store.paths.wal).subarray(16, 24).equals(before)).toBe(false);
    } finally {
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
    }
    expect((await checkpointing).barrier).toBe(true);
    await covered;
    const next = store.flushed();
    const report = await pass(store);
    await next;
    expect(report).toMatchObject({ dirty: true, barrier: true });
    expect(report.checkpoint?.checkpointed).toBe(report.checkpoint?.log);
    // Reopen an independent copy, with no live shared-memory state. Its DB
    // contains the synchronized backfill and its WAL covers the reused epoch.
    const snapshot = join(root, "snapshot.sqlite");
    copyFileSync(store.paths.database, snapshot);
    copyFileSync(store.paths.wal, `${snapshot}-wal`);
    const recovered = new sqlite!.DatabaseSync(snapshot);
    try {
      expect(recovered.prepare("SELECT id FROM checkpoint_test ORDER BY id").all()).toEqual([
        { id: 1 },
        { id: 2 },
      ]);
      expect(recovered.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      recovered.close();
    }
  });

  it("reclaims a WAL larger than the former autocheckpoint threshold after a pinned reader ends", async () => {
    const store = await open();
    store.exec("PRAGMA journal_size_limit=1048576");
    write(store, 0);
    await pass(store);
    const reader = new sqlite!.DatabaseSync(store.paths.database, { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT * FROM checkpoint_test").get();
    try {
      for (let i = 1; i <= 80; i++) write(store, 0);
      const pinned = await pass(store);
      expect(statSync(store.paths.wal).size).toBeGreaterThan(16 * 1024 * 1024);
      expect(pinned.checkpoint!.checkpointed).toBeLessThan(pinned.checkpoint!.log);
    } finally {
      reader.exec("COMMIT");
      reader.close();
    }
    const released = await pass(store);
    expect(released.checkpoint!.checkpointed).toBe(released.checkpoint!.log);
    write(store, 1, 16);
    await pass(store);
    expect(statSync(store.paths.wal).size).toBeLessThanOrEqual(1024 * 1024);
  });

  it("restarts a large WAL in the worker, reporting a pinned reader without waiting", async () => {
    const store = await open({ restartThresholdPages: 1 });
    store.exec("PRAGMA journal_size_limit=1048576");
    write(store, 0);
    await pass(store);
    const reader = new sqlite!.DatabaseSync(store.paths.database);
    reader.exec("BEGIN");
    reader.prepare("SELECT id FROM checkpoint_test").all();
    try {
      for (let i = 0; i < 12; i++) write(store, 0);
      const pinned = await pass(store);
      // RESTART, unlike PASSIVE, reports BUSY when the reader prevents reuse.
      expect(pinned.checkpoint!.busy).toBe(1);
      expect(pinned.barrier).toBe(true);
      expect(store.facts().flusher.counters.deaths).toBe(0);
    } finally {
      reader.exec("COMMIT");
      reader.close();
    }
    const reclaimed = await pass(store);
    expect(reclaimed.checkpoint!.busy).toBe(0);
    expect(reclaimed.checkpoint!.checkpointed).toBe(reclaimed.checkpoint!.log);
    const salt = readFileSync(store.paths.wal).subarray(16, 24);
    write(store, 1, 16);
    expect(readFileSync(store.paths.wal).subarray(16, 24).equals(salt)).toBe(false);
    expect(statSync(store.paths.wal).size).toBeLessThanOrEqual(1024 * 1024);
    const durable = store.flushed();
    expect((await pass(store)).barrier).toBe(true);
    await durable;
  });

  it("bounds an outage, then restarts and reclaims accumulated WAL", async () => {
    const store = await open({ allowExit: true });
    store.exec("PRAGMA journal_size_limit=1048576");
    for (let i = 0; i < 80; i++) write(store, 0);
    expect(statSync(store.paths.wal).size).toBeGreaterThan(16 * 1024 * 1024);
    const pending = store.flushed().catch((error: unknown) => error);
    store.flusherControl.requestExit(3);
    expect(await pending).toBeInstanceOf(StoreFlushUnavailableError);
    // Failure callers may save their terminal record during a normal restart.
    write(store, 2, 16);
    await until(() => store.facts().flusher.state === "up");
    // A restarted worker is insufficient: it must prove a successful pass.
    // Manual ticking holds it before that proof, modeling repeated failures.
    await new Promise((resolve) => setTimeout(resolve, 1050));
    let bodyRan = false;
    expect(() =>
      store.transaction(() => {
        bodyRan = true;
      }),
    ).toThrow(StoreFlushUnavailableError);
    expect(bodyRan).toBe(false);
    expect(store.facts().flusher.counters).toMatchObject({ deaths: 1, restarts: 1 });
    const after = await pass(store);
    expect(after).toMatchObject({ dirty: true, barrier: true });
    expect(after.checkpoint!.checkpointed).toBe(after.checkpoint!.log);
    write(store, 1, 16);
    await pass(store);
    expect(statSync(store.paths.wal).size).toBeLessThanOrEqual(1024 * 1024);
  });

  it("closes the writer before the worker's final barrier and last-close checkpoint", async () => {
    const store = await open();
    write(store, 1);
    store.registerExternal(root);
    const db = store.db;
    const nativeClose = db.close.bind(db);
    const writerClose = vi.spyOn(db, "close").mockImplementation(() => {
      nativeClose();
      // A remaining worker connection keeps the WAL alive; the writer was
      // not the connection that ran SQLite's last-close checkpoint.
      expect(existsSync(store.paths.wal)).toBe(true);
    });
    await store.close();
    expect(writerClose).toHaveBeenCalledOnce();
    expect(store.isClosed).toBe(true);
    expect(existsSync(store.paths.wal)).toBe(false);
    const recovered = new sqlite!.DatabaseSync(store.paths.database, { readOnly: true });
    try {
      expect(recovered.prepare("SELECT id FROM checkpoint_test").all()).toEqual([{ id: 1 }]);
    } finally {
      recovered.close();
    }
  });
});
