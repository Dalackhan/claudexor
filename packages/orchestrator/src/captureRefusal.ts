import type { WorkspaceEnvelope, WorkspaceCaptureFailure } from "@claudexor/schema";
import {
  captureFailureEvidence,
  envelopeBaseOf,
  readEnvelopeCustody,
  retainForInspection,
  retainForContinuation,
  type WorkspaceManager,
} from "@claudexor/workspace";

/** Incomplete capture preserves the original source; it never implies a clean tree. */
export interface CaptureRefusal {
  disposition: "discarded" | "manual_cleanup" | "retained";
  detail: string;
  phase?: "workspace" | "artifact_security";
  failure?: WorkspaceCaptureFailure;
  sourceRoot?: string;
  retentionFailure?: WorkspaceCaptureFailure;
}

/** Where the kept source and a failed scratch cleanup can be inspected; a
 * terminal with its own remedy (budget, cancel) appends these instead of a retry. */
export function captureInspectionActions(refusal: CaptureRefusal | undefined): string[] {
  if (!refusal) return [];
  return [
    ...(refusal.sourceRoot
      ? [`Inspect the changed files at ${refusal.sourceRoot}`]
      : refusal.disposition === "manual_cleanup"
        ? ["Inspect the changed files in the project folder directly"]
        : []),
    ...(refusal.failure?.cleanup
      ? ["Inspect Claudexor temporary state: private scratch cleanup failed"]
      : []),
  ];
}

export function captureRefusalNextActions(refusal: CaptureRefusal): string[] {
  return [...captureInspectionActions(refusal), "Retry the run"];
}

/** Existing custody is the durability owner; only an eligible singleton gets
 * the singular continuation pointer. Other candidates are addressed by attempt. */
export function preserveCaptureSource(input: {
  wsm: WorkspaceManager;
  envelope: WorkspaceEnvelope;
  inPlace: boolean;
  holder: { runId: string; runDir: string };
  error?: Error;
}): CaptureRefusal {
  const { wsm, envelope, inPlace, holder } = input;
  let retentionFailure: WorkspaceCaptureFailure | undefined;
  if (!inPlace) {
    wsm.retainEnvelope(envelope);
    try {
      const current = readEnvelopeCustody(envelopeBaseOf(envelope));
      if (current?.holder_run_id === holder.runId && current.continuation_eligible !== false)
        retainForContinuation(envelope, holder, null);
      else retainForInspection(envelope, holder);
    } catch (error) {
      // Preserve the completed answer/accounting even if persistence itself fails.
      // The process-local hold remains, but durable recovery is explicitly unproven.
      retentionFailure = captureFailureEvidence(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
  return {
    disposition: inPlace || retentionFailure ? "manual_cleanup" : "retained",
    phase: "workspace",
    sourceRoot: envelope.worktree_path,
    failure: captureFailureEvidence(input.error),
    ...(retentionFailure ? { retentionFailure } : {}),
    detail: inPlace
      ? "Candidate output could not be captured as a complete patch; changed files are untouched and need direct inspection"
      : retentionFailure
        ? "Candidate output could not be captured completely; source is held in this process but durable retention could not be recorded"
        : "Candidate output could not be captured completely; the isolated source is retained for direct inspection",
  };
}
