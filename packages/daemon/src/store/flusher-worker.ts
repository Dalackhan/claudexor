import { closeSync, fstatSync, fsyncSync, openSync, statSync } from "node:fs";
import { isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { fsyncDirectory } from "@claudexor/util";
import { applyPragmas, FLUSHER_CONNECTION_PRAGMAS } from "./pragmas.js";
import type { StatementSync } from "node:sqlite";
import { loadEngineRuntime } from "./runtime.js";
import {
  CHECKPOINT_EVERY_PASSES,
  FLUSH_INTERVAL_MS,
  WAL_RESTART_PAGES,
  STORE_WORKER_DATA_KEY,
  type FlusherCommand,
  type FlusherCounters,
  type FlusherEvent,
  type FlusherWorkerData,
} from "./flusher-protocol.js";

/**
 * The flusher pass (SYNTHESIS_R5 §4.2), every 200 ms:
 *   1. g_target := the highest generation received so far (FIFO: every
 *      registration or flush request handled before this tick is covered);
 *   2. one F_FULLFSYNC per directory touched by a covered registration;
 *   3. `PRAGMA data_version` → dirty := anything committed since the last
 *      PROVEN barrier (the first pass of a worker life is always dirty);
 *   4. every CHECKPOINT_EVERY_PASSES passes, or every pass while the WAL is at
 *      its reuse trigger: PASSIVE checkpoint, then try RESTART at that trigger to
 *      prevent continuous writers from starving reuse. Both are space reclamation
 *      only; their result is reported as a fact and NEVER decides whether to sync;
 *   5. if dirty: the explicit `fsyncSync(walFd)` — the barrier: it fixes the
 *      WAL frames and, as a device-wide barrier on macOS, the O_DSYNC file
 *      data already handed to the drive. Database pages become durable
 *      through the ff-checkpoint (`checkpoint_fullfsync=1` on every
 *      checkpointing connection) before the WAL is reused, not through this
 *      fsync (R5_AMENDMENTS B5);
 *   6. `synced(g_target)` with the pass facts.
 * The worker never writes a row and never waits for a lock. `node:sqlite` is
 * imported lazily so the daemon package loads on a Node without it and the
 * typed `engine_runtime_unsupported` stays reachable.
 */
export async function runFlusherWorker(port: MessagePort, data: FlusherWorkerData): Promise<void> {
  const hooks = data.hooks ?? {};
  const walPath = `${data.dbPath}-wal`;
  const { sqlite } = await loadEngineRuntime();
  const db = new sqlite.DatabaseSync(data.dbPath, { timeout: 0 });
  applyPragmas(db, FLUSHER_CONNECTION_PRAGMAS);
  const dataVersion = db.prepare("PRAGMA data_version");
  const passive = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
  const restart = db.prepare("PRAGMA wal_checkpoint(RESTART)");
  const restartPages = hooks.restartThresholdPages ?? WAL_RESTART_PAGES;
  const checkpointEvery = hooks.checkpointEveryPasses ?? CHECKPOINT_EVERY_PASSES;
  // The first pass of a worker life checkpoints; then the cadence, or the last observed WAL size, decides.
  let sinceCheckpoint = checkpointEvery;
  let lastLog = 0;
  const checkpointFacts = (statement: StatementSync) => {
    const row = statement.get() as
      { busy: number | bigint; log: number | bigint; checkpointed: number | bigint } | undefined;
    return row
      ? { busy: Number(row.busy), log: Number(row.log), checkpointed: Number(row.checkpointed) }
      : null;
  };
  const counters: FlusherCounters = {
    passes: 0,
    barriers: 0,
    dirSyncs: 0,
    busyPassive: 0,
    walReopens: 0,
  };
  const pendingDirs = new Set<string>();
  let gMax = 0;
  let lastProvenDataVersion: number | null = null;
  let walFd: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const post = (event: FlusherEvent): void => port.postMessage(event);

  const closeWal = (): void => {
    if (walFd === null) return;
    closeSync(walFd);
    walFd = null;
  };

  /** `r+` on the WAL file, never written through; reopened when the inode moved. */
  const ensureWalFd = (): number => {
    const onDisk = statSync(walPath, { throwIfNoEntry: false });
    if (walFd !== null) {
      if (onDisk && fstatSync(walFd).ino === onDisk.ino) return walFd;
      closeWal();
      counters.walReopens += 1;
    }
    walFd = openSync(walPath, "r+");
    return walFd;
  };

  const pass = (): void => {
    if (stopped) return;
    const started = performance.now();
    const gTarget = gMax;
    const dirsSynced: string[] = [];
    const dirsMissing: string[] = [];
    for (const dir of pendingDirs) {
      // A directory removed since its registration has no entries left to
      // make durable; whoever removed it registered the parent. Any other
      // failure is fatal to this worker life (fail loud, restart).
      try {
        fsyncDirectory(dir);
        dirsSynced.push(dir);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
        dirsMissing.push(dir);
      }
    }
    pendingDirs.clear();
    counters.dirSyncs += dirsSynced.length;
    const observed = Number((dataVersion.get() as { data_version: number | bigint }).data_version);
    const dirty = lastProvenDataVersion === null || observed !== lastProvenDataVersion;
    let checkpoint: ReturnType<typeof checkpointFacts> = null;
    sinceCheckpoint += 1;
    if (sinceCheckpoint >= checkpointEvery || lastLog >= restartPages) {
      sinceCheckpoint = 0;
      checkpoint = checkpointFacts(passive);
      if (checkpoint?.busy) counters.busyPassive += 1;
      // PASSIVE can finish a captured prefix while the writer appends beyond it,
      // indefinitely preventing reuse. RESTART acquires the writer lock to finish
      // the tail. busy_timeout=0 returns immediately when a reader/writer pins it;
      // the next pass retries, and the explicit barrier still runs below.
      if (checkpoint && checkpoint.log >= restartPages) checkpoint = checkpointFacts(restart);
      // While the WAL holds at least the trigger (backfilled or not), every pass retries until a
      // writer has restarted it; a BUSY RESTART must not wait for the cadence.
      lastLog = checkpoint ? checkpoint.log : lastLog;
    }
    if (hooks.checkpointGate) {
      const gate = new Int32Array(hooks.checkpointGate);
      if (Atomics.compareExchange(gate, 0, 1, 2) === 1) Atomics.wait(gate, 1, 0, 10_000);
    }
    if (hooks.passDelayMs) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hooks.passDelayMs);
    }
    let barrier = false;
    let barrierMs: number | null = null;
    if (dirty) {
      const fd = ensureWalFd();
      const t0 = performance.now();
      fsyncSync(fd);
      barrierMs = performance.now() - t0;
      barrier = true;
      counters.barriers += 1;
      lastProvenDataVersion = observed;
    }
    counters.passes += 1;
    const wal = statSync(walPath, { throwIfNoEntry: false });
    post({
      type: "synced",
      report: {
        g: gTarget,
        dirty,
        barrier,
        dirsSynced,
        dirsMissing,
        checkpoint,
        walBytes: wal ? wal.size : null,
        passMs: performance.now() - started,
        barrierMs,
        counters: { ...counters },
        at: Date.now(),
      },
    });
  };

  const stop = (): void => {
    // The writer has closed while this connection kept the WAL open. Finish
    // directory registrations and the barrier before the last-close checkpoint.
    pass();
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    closeWal();
    db.close();
    post({ type: "stopped" });
    port.close();
  };

  const schedule = (): void => {
    if (stopped || hooks.manualTick) return;
    timer = setTimeout(() => {
      pass();
      schedule();
    }, FLUSH_INTERVAL_MS);
  };

  port.on("message", (command: FlusherCommand) => {
    switch (command.type) {
      case "register":
        pendingDirs.add(command.dir);
        gMax = Math.max(gMax, command.g);
        return;
      case "flush":
        gMax = Math.max(gMax, command.g);
        return;
      case "tick":
        if (hooks.manualTick) pass();
        return;
      case "exit":
        if (hooks.allowExit) process.exit(command.code);
        return;
      case "stop":
        stop();
        return;
    }
  });
  post({ type: "ready", at: Date.now() });
  schedule();
}

const spawnData = workerData as Partial<FlusherWorkerData> | null | undefined;
if (!isMainThread && parentPort && spawnData?.[STORE_WORKER_DATA_KEY] === "flusher") {
  void runFlusherWorker(parentPort, spawnData as FlusherWorkerData).catch((error: unknown) => {
    throw error;
  });
}
