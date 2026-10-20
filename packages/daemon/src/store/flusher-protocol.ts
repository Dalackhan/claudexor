import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Flusher pass interval (SYNTHESIS_R5 §4.2): a code constant, not a knob. */
export const FLUSH_INTERVAL_MS = 200;
/** Preserve the former main autocheckpoint trigger, now enforced by the worker. */
export const WAL_RESTART_PAGES = 4000;

/** The `workerData` discriminator every store worker is spawned with. The
 * worker modules self-start on it, so the same module graph serves the dev
 * `dist/` layout (adjacent worker file) and the single-file daemon bundle
 * (the bundle itself is the worker entry and dispatches by this key). */
export const STORE_WORKER_DATA_KEY = "claudexorStoreWorker";

/** Test seams of the flusher worker. Inert unless the store was opened with them. */
export interface FlusherHooks {
  /** Passes run only on an explicit `tick` command (generation causality tests). */
  manualTick?: boolean;
  /** Honour an `exit` command (worker-death tests). */
  allowExit?: boolean;
  /** Sleep inside the pass, between checkpoint and barrier (kill-during-pass tests). */
  passDelayMs?: number;
  /** Test gate after checkpoint: [1,0] pauses at [2,0] until index 1 is notified. */
  checkpointGate?: SharedArrayBuffer;
  /** Exercise the bounded RESTART path without a 16 MiB test WAL. */
  restartThresholdPages?: number;
}

export interface FlusherWorkerData {
  [STORE_WORKER_DATA_KEY]: "flusher";
  dbPath: string;
  hooks: FlusherHooks;
}

export type FlusherCommand =
  | { type: "register"; g: number; dir: string }
  | { type: "flush"; g: number }
  | { type: "tick" }
  | { type: "exit"; code: number }
  | { type: "stop" };

export interface FlusherCounters {
  passes: number;
  barriers: number;
  dirSyncs: number;
  busyPassive: number;
  walReopens: number;
}

export interface FlusherPassReport {
  /** Highest generation received before the pass started; everything up to it is covered. */
  g: number;
  dirty: boolean;
  /** The explicit WAL F_FULLFSYNC ran in this pass. Never derived from the checkpoint result. */
  barrier: boolean;
  dirsSynced: string[];
  /** Registered directories that no longer existed at pass time (nothing left to prove). */
  dirsMissing: string[];
  /** Raw `PRAGMA wal_checkpoint(PASSIVE)` row — informational, never a barrier proof. */
  checkpoint: { busy: number; log: number; checkpointed: number } | null;
  walBytes: number | null;
  passMs: number;
  barrierMs: number | null;
  counters: FlusherCounters;
  at: number;
}

export type FlusherEvent =
  | { type: "ready"; at: number }
  | { type: "synced"; report: FlusherPassReport }
  | { type: "stopped" };

/**
 * Where a store worker starts. Beside this module in the built `dist/` tree
 * the worker file exists and is the entry; inside the single-file daemon
 * bundle `import.meta.url` IS the bundle (esbuild defines it so), the
 * adjacent file does not exist, and the bundle itself is the entry — it
 * embeds the worker modules, which self-start on `workerData`.
 */
export function resolveStoreWorkerEntry(moduleUrl: string, workerFile: string): string {
  const adjacent = fileURLToPath(new URL(`./${workerFile}`, moduleUrl));
  if (existsSync(adjacent)) return adjacent;
  return fileURLToPath(moduleUrl);
}
