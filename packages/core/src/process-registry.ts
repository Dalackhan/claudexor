/**
 * Passive registry of live harness child process groups. Every
 * `spawnProcess` child registers on spawn and unregisters on close; the
 * daemon snapshots the registry into a pids file so a crashed/killed daemon
 * can REAP surviving orphans on the next start (children live in their own
 * process groups by design, so they outlive the daemon). Purely
 * observational: adapters gain no orchestration behavior.
 *
 * A child spawned with a run scope marker in its env records that marker
 * NAME here (never the value or any other env byte), so the daemon's capture
 * tick can walk the child's descendants and attribute them to the run that
 * must end them (DIRECTIVE 1, the second membership source).
 */
import { defaultProcessGroupService, type ProcessGroupHandle } from "./process-group.js";

interface LiveChildProcess {
  pid: number;
  cmd: string;
  processGroup: ProcessGroupHandle;
  /** The run scope marker this child was spawned under, when any. */
  scopeMarker?: string;
}

const live = new Map<number, LiveChildProcess>();

export function registerChildProcess(pid: number, cmd: string, scopeMarker?: string): void {
  const captured = defaultProcessGroupService.captureLeader(pid);
  if (captured.status === "known") {
    live.set(pid, {
      pid,
      cmd,
      processGroup: captured.handle,
      ...(scopeMarker ? { scopeMarker } : {}),
    });
  } else live.delete(pid);
}

export function unregisterChildProcess(pid: number): void {
  live.delete(pid);
}

/** Snapshot of children whose exact kernel process-group identity was captured. */
export function liveChildProcesses(): LiveChildProcess[] {
  return [...live.values()];
}
