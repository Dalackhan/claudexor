import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  StoreBusyError,
  StoreCorruptError,
  StoreError,
  StoreFullError,
  mapStoreError,
} from "./errors.js";
import { EngineStore } from "./store.js";

/** The store runs only where `node:sqlite` exists; elsewhere these cases are skipped, not failed. */
const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;

function builtWorkerEntry(name: string): string {
  const entry = resolve(import.meta.dirname, "../../dist/store", name);
  if (!existsSync(entry)) throw new Error(`built worker missing at ${entry}; run pnpm build first`);
  return entry;
}

function sqliteError(errcode: number, message = "sqlite failure"): Error {
  return Object.assign(new Error(message), { code: "ERR_SQLITE_ERROR", errcode, errstr: message });
}

describeStore("typed store errors", () => {
  it("maps SQLite result codes and ENOSPC onto the store classes, leaves the rest alone", () => {
    expect(mapStoreError(sqliteError(13, "database or disk is full"), "commit")).toBeInstanceOf(
      StoreFullError,
    );
    expect(mapStoreError(sqliteError(13 | (1 << 8)), "commit")).toMatchObject({
      code: "store_full",
      status: 507,
      retryable: true,
    });
    expect(mapStoreError(sqliteError(11), "read")).toBeInstanceOf(StoreCorruptError);
    expect(mapStoreError(sqliteError(26), "read")).toMatchObject({
      code: "store_corrupt",
      retryable: false,
    });
    expect(mapStoreError(sqliteError(5), "write")).toBeInstanceOf(StoreBusyError);
    expect(mapStoreError(sqliteError(6 | (2 << 8)), "write")).toMatchObject({
      code: "store_busy",
      retryable: true,
    });
    expect(
      mapStoreError(Object.assign(new Error("no space"), { code: "ENOSPC" }), "file"),
    ).toBeInstanceOf(StoreFullError);
    const other = sqliteError(19, "constraint failed");
    expect(mapStoreError(other, "insert")).toBe(other);
    const plain = new Error("plain");
    expect(mapStoreError(plain, "x")).toBe(plain);
    const typed = new StoreError("store_closed", 503, false, "closed");
    expect(mapStoreError(typed, "x")).toBe(typed);
    expect((mapStoreError(sqliteError(13), "committing") as Error).message).toContain("committing");
  });
});

/** A 8 MiB HFS+ RAM disk: real ENOSPC without touching the host filesystem (macOS only). */
function ramDisk(): { mount: string; detach: () => void } | null {
  if (process.platform !== "darwin") return null;
  let device = "";
  try {
    device = execFileSync("hdiutil", ["attach", "-nomount", "ram://16384"], {
      encoding: "utf8",
    }).trim();
    const name = `cx-store-enospc-${process.pid}-${Date.now()}`;
    execFileSync("diskutil", ["eraseVolume", "HFS+", name, device], {
      encoding: "utf8",
      stdio: "pipe",
    });
    const mount = `/Volumes/${name}`;
    if (!existsSync(mount)) throw new Error("volume did not mount");
    return {
      mount,
      detach: () => {
        try {
          execFileSync("hdiutil", ["detach", device, "-force"], { stdio: "ignore" });
        } catch (error) {
          if (existsSync(mount)) throw error;
        }
      },
    };
  } catch {
    if (device) {
      try {
        execFileSync("hdiutil", ["detach", device, "-force"], { stdio: "ignore" });
      } catch {
        /* nothing to release */
      }
    }
    return null;
  }
}

describeStore("ENOSPC → store_full on a full volume", () => {
  it("a commit that runs out of space fails typed and the store stays usable", async (context) => {
    // Setup, assertions and cleanup share this test's existing 30 s budget.
    const disk = ramDisk();
    if (!disk) {
      context.skip();
      return;
    }
    let store: EngineStore | undefined;
    try {
      store = await EngineStore.open({
        daemonDir: join(disk.mount, "daemon"),
        workerEntry: builtWorkerEntry("flusher-worker.js"),
      });
      const insert = store.prepare(
        "INSERT INTO event(pid, seq, time, type, payload) VALUES(1, ?, 't', 'x', ?)",
      );
      let failure: unknown = null;
      let committed = 0;
      for (let i = 1; i <= 400 && failure === null; i += 1) {
        try {
          store.transaction(() => void insert.run(i, Buffer.alloc(64 * 1024, i & 0xff)));
          committed += 1;
        } catch (error) {
          failure = error;
        }
      }
      expect(failure).toBeInstanceOf(StoreFullError);
      expect(failure).toMatchObject({ code: "store_full", status: 507, retryable: true });
      expect(committed).toBeGreaterThan(0);
      // The failed transaction rolled back; the committed prefix is readable.
      expect(store.inTransaction).toBe(false);
      const n = Number((store.prepare("SELECT count(*) AS n FROM event").get() as { n: number }).n);
      expect(n).toBe(committed);
      expect(store.facts().busy_waits).toBe(0);
    } finally {
      const closeStarted = performance.now();
      let closeError: unknown;
      console.info(`[ENOSPC cleanup] close:start ${disk.mount}`);
      try {
        await store?.close();
      } catch (error) {
        closeError = error;
        throw error;
      } finally {
        console.info(`[ENOSPC cleanup] close:end elapsed_ms=${performance.now() - closeStarted}`);
        const detachStarted = performance.now();
        console.info(`[ENOSPC cleanup] detach:start ${disk.mount}`);
        try {
          disk.detach();
        } catch (error) {
          if (closeError !== undefined)
            throw new AggregateError([closeError, error], "store close and RAM detach failed");
          throw error;
        } finally {
          console.info(
            `[ENOSPC cleanup] detach:end elapsed_ms=${performance.now() - detachStarted}`,
          );
        }
      }
    }
  });
});
