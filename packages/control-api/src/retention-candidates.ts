import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { isTerminalLifecycle, type GcKeepCounts } from "@claudexor/schema";
import { readTextSafe } from "@claudexor/util";
import { holdsRetainedSources } from "@claudexor/workspace";
import type { RetentionRunRecord } from "./retention.js";

/** The same guards judge an inventory candidate and its final deletion recheck. */
export function runKeepReason(
  root: string,
  runId: string,
  record: RetentionRunRecord | undefined,
  referenced: ReadonlySet<string>,
  cutoff: number,
  report: (error: unknown) => void,
): Exclude<keyof GcKeepCounts, "recent"> | null {
  if (record && !isTerminalLifecycle(record.state)) return "active";
  if (referenced.has(runId)) return "referenced";
  if (hasActionableWorkProduct(root) || holdsRetainedSources(root, runId, report))
    return "actionable";
  if (!record && !hasTerminalEvidence(root)) return "unknown_state";
  if (ageStampOf(root, record) > cutoff) return "young";
  return null;
}

function hasTerminalEvidence(runRoot: string): boolean {
  // Terminality is proven by TYPED terminal artifacts (D8/V8): the arbitration
  // decision (carries facts), the typed failure record, or the work product —
  // never the diagnostic summary.md (its authority role was retired).
  return (
    existsSync(join(runRoot, "arbitration", "decision.yaml")) ||
    existsSync(join(runRoot, "final", "failure.yaml")) ||
    existsSync(join(runRoot, "final", "work_product.yaml"))
  );
}

/** True when the run's tree is still the operator's to act on (D8): an
 * undelivered/applyable patch, OR a needs-decision terminal (decision.facts
 * review blocked / checks failed) with a work product present. */
function hasActionableWorkProduct(runRoot: string): boolean {
  const delivery = readTextSafe(join(runRoot, "final", "delivery_state.yaml"));
  if (delivery !== null) {
    try {
      if ((yamlParse(delivery) as { applyState?: unknown })?.applyState === "discarded")
        return false;
    } catch {
      return true;
    }
  }
  // Needs-decision keep: a succeeded terminal whose review is blocked or checks
  // failed is actionable regardless of apply state.
  const decisionText = readTextSafe(join(runRoot, "arbitration", "decision.yaml"));
  if (decisionText !== null) {
    try {
      const facts = ((yamlParse(decisionText) ?? {}) as { facts?: Record<string, unknown> }).facts;
      if (
        facts &&
        facts["lifecycle"] === "succeeded" &&
        (facts["review"] === "blocked" || facts["checks"] === "failed")
      ) {
        return true;
      }
    } catch {
      return true; // unreadable decision: fail closed, keep the tree
    }
  }
  const text = readTextSafe(join(runRoot, "final", "work_product.yaml"));
  if (text === null) return false;
  try {
    const doc = (yamlParse(text) ?? {}) as { kind?: unknown; meta?: unknown };
    const meta = (doc.meta ?? {}) as Record<string, unknown>;
    // The canonical discriminator is the TOP-LEVEL kind (release wave
    // round-13): convergence writes kind: patch without meta.result_kind, and
    // deleting its unapplied tree would destroy actionable work.
    if (
      doc.kind !== "patch" &&
      doc.kind !== "files" &&
      doc.kind !== "new_repo" &&
      meta["result_kind"] !== "patch"
    )
      return false;
    // Non-success Git drafts cannot be applied. Preserve their normal age and
    // reference retention, not an action that can never be completed.
    if (
      doc.kind !== "files" &&
      ["cancelled", "failed", "interrupted"].includes(String(meta["lifecycle"]))
    )
      return false;
    // Delivery/apply state is the mutable overlay (final/delivery_state.yaml);
    // fall back to the immutable work_product snapshot. An undelivered patch is
    // still the operator's to act on; applied and reverted have completed.
    const deliveryText = readTextSafe(join(runRoot, "final", "delivery_state.yaml"));
    let applyState: unknown = meta["apply_state"];
    if (deliveryText !== null) {
      try {
        applyState =
          ((yamlParse(deliveryText) ?? {}) as { applyState?: unknown }).applyState ?? applyState;
      } catch {
        return true;
      }
    }
    return applyState !== "applied" && applyState !== "reverted" && applyState !== "discarded";
  } catch {
    return true; // unreadable work product: fail closed, keep the tree
  }
}

export function ageStampOf(runRoot: string, record: RetentionRunRecord | undefined): number {
  const finished = Date.parse(record?.finishedAt ?? "");
  if (Number.isFinite(finished)) return finished;
  try {
    return statSync(runRoot).mtimeMs;
  } catch {
    return Date.now();
  }
}
