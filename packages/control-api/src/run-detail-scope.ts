import { type ControlProcessScope, RunProcessScopeOutcome } from "@claudexor/schema";
import type { DaemonRunRecord } from "./run-record.js";
import { safeReadStructuredArtifact } from "./run-artifact-read.js";

/** The run lifecycle has ended (ControlRunState terminal members). */
function isTerminalRunState(state: string): boolean {
  return (
    state === "succeeded" || state === "failed" || state === "cancelled" || state === "interrupted"
  );
}

/**
 * `summary.processScope` of a run detail (INV-144): the compact scope outcome
 * projected from `final/process_scope.yaml` so a host can decide whether to
 * reuse the workspace. The artifact is written before the terminal is
 * published, so a live run can already carry it: the projection is null until
 * the run is terminal, and null for historical runs without the artifact
 * (unknown, never clean).
 */
export function projectProcessScope(
  rec: DaemonRunRecord,
  state: string,
): ControlProcessScope | null {
  if (!isTerminalRunState(state)) return null;
  const scope = safeReadStructuredArtifact(rec, "final/process_scope.yaml", RunProcessScopeOutcome);
  return scope
    ? {
        settled: scope.settled,
        coverage: scope.coverage,
        completeness: scope.completeness,
        census: scope.census,
        survivors: scope.survivors.length,
        unreadable: scope.unreadable.length,
      }
    : null;
}
