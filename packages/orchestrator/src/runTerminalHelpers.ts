/**
 * Pure helpers of the whole-strategy terminal net (`runTerminals.ts`): the
 * terminal event type from the canonical axes, cancel-reason mapping, payload
 * decoding, committed-outcome recovery and the post-drain budget failure.
 */
import { join } from "node:path";
import {
  type CancelReasonCode,
  makeOutcomeFacts,
  needsOperatorAttention,
  normalizeCancelReasonCode,
  RunOutcomeFacts,
  type RunOutcomeFacts as RunOutcomeFactsType,
} from "@claudexor/schema";
import type { BudgetTerminal } from "@claudexor/budget";
import type { TerminalRunEventType } from "@claudexor/event-log";
import { readTextSafe } from "@claudexor/util";
import { budgetFailureRecord, classifyBudgetFailure } from "./budgetFailure.js";
import { reconcileDecisionBudget, type SettledBudgetSnapshot } from "./decisionBudget.js";
import type { OrchestratorResult } from "./orchestrator.js";
import type { AnnouncedRunContext } from "./runTerminalContext.js";
import { writeFailure } from "./runTerminalResults.js";
import { reconcileWorkProductTerminal, terminalOutcomeFacts } from "./terminalOutcome.js";

export function ownsDelegateDrain(context: AnnouncedRunContext): boolean {
  try {
    return context.recheckBudgetAfterBarrier?.() === true;
  } catch {
    // Reconciliation is an extra authority granted only to a proven Delegate
    // drain owner. An unreadable ownership predicate must fail closed instead
    // of touching an ordinary Agent's already-terminal artifacts.
    return false;
  }
}

export function postDrainBudgetFailure(
  context: AnnouncedRunContext,
  terminal: Exclude<BudgetTerminal, null>,
  budget: SettledBudgetSnapshot,
  prior: OrchestratorResult,
): OrchestratorResult {
  const mapping = classifyBudgetFailure({ denial: null, terminal });
  const facts = terminalOutcomeFacts(prior.facts, "failed", mapping.reason);
  reconcileDecisionBudget(context, budget, { facts, why: mapping.safeMessage });
  reconcileWorkProductTerminal(context, facts);
  context.store.writeText(
    join(context.paths.finalDir, "summary.md"),
    `# Run ${context.runId} (${context.mode})\n\n- Lifecycle: failed (${mapping.reason})\n- Phase: budget\n\n${mapping.safeMessage}\n`,
  );
  writeFailure(
    context.store,
    context.paths,
    budgetFailureRecord(mapping, { runDir: context.paths.root }),
  );
  context.log.emit("output.ready", {
    kind: "summary",
    path: "final/summary.md",
    state: "diagnostic",
  });
  context.log.emit("run.failed", {
    lifecycle: "failed",
    facts,
    reason: mapping.reason,
    phase: "budget",
    error: mapping.safeMessage,
    failure_ref: "final/failure.yaml",
  });
  return {
    ...prior,
    lifecycle: "failed",
    facts,
    summary: mapping.safeMessage,
    spendUsd: budget.spendUsd,
  };
}

export function terminalEventTypeFor(
  _originalType: TerminalRunEventType,
  outcome: RunOutcomeFactsType,
): TerminalRunEventType {
  if (outcome.lifecycle !== "succeeded") return "run.failed";
  if (needsOperatorAttention(outcome, false)) return "run.blocked";
  // The canonical axes own terminal type. Preserving a producer-authored
  // run.blocked with clean axes creates an unexplainable block (no reason or
  // required action), so it is normalized to completed.
  return "run.completed";
}

/** Map an abort-signal reason token to its typed terminal RunReason. The
 * abort reason is the ONE channel a cancel's provenance survives on — before
 * this mapping every host-initiated cancel coerced to user_cancelled (the
 * daemon's own ctrl-c relay and the MCP host teardown included). The client
 * vocabulary is read from CANCEL_REASON_CODES so a future member cannot be
 * silently coerced away here while the HTTP boundary already admits it;
 * wall_clock_exceeded stays daemon-internal (deliberately NOT in the client
 * enum — unforgeable). Unknown tokens keep the user_cancelled coercion for
 * wire compatibility. */
export function cancelReasonFromSignalToken(
  reason: unknown,
): "wall_clock_exceeded" | CancelReasonCode {
  if (reason === "wall_clock_exceeded") return "wall_clock_exceeded";
  return normalizeCancelReasonCode(reason) ?? "user_cancelled";
}

export function cancellationFacts(
  signal: AbortSignal,
  prior: RunOutcomeFactsType,
): RunOutcomeFactsType {
  return terminalOutcomeFacts(prior, "cancelled", cancelReasonFromSignalToken(signal.reason));
}

export function terminalOutcomeFromPayload(payload: Record<string, unknown>): RunOutcomeFactsType {
  const parsed = RunOutcomeFacts.safeParse(payload["facts"]);
  if (parsed.success) return parsed.data;
  // Older in-process terminal producers (including the Delegate drain
  // contract) supplied only lifecycle. Keep that compatible while treating an
  // explicitly malformed facts object as a contradiction that must fail
  // closed through the terminal-facts path below.
  if (!Object.prototype.hasOwnProperty.call(payload, "facts")) {
    const lifecycle = payload["lifecycle"];
    if (
      lifecycle === "succeeded" ||
      lifecycle === "failed" ||
      lifecycle === "cancelled" ||
      lifecycle === "interrupted"
    ) {
      return makeOutcomeFacts(lifecycle);
    }
  }
  return RunOutcomeFacts.parse(payload["facts"]);
}

export function settledSpend(a: AnnouncedRunContext): number | null {
  try {
    return a.spend ? a.spend() : null;
  } catch {
    return null;
  }
}

export function isTerminalRecoveryRequired(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "terminal_recovery_required"
  );
}

export function committedOutcome(a: AnnouncedRunContext): RunOutcomeFactsType | null {
  const terminal = [...a.log.readAll().events]
    .reverse()
    .find(
      (event) =>
        event.type === "run.completed" ||
        event.type === "run.blocked" ||
        event.type === "run.failed",
    );
  const parsed = RunOutcomeFacts.safeParse(terminal?.payload["facts"]);
  return parsed.success ? parsed.data : null;
}

export function committedResult(
  a: AnnouncedRunContext,
  outcome: RunOutcomeFactsType,
  spendUsd: number | null,
): OrchestratorResult {
  const summary =
    readTextSafe(join(a.paths.finalDir, "summary.md"))?.trim().slice(0, 400) ??
    `run terminal committed with lifecycle ${outcome.lifecycle}`;
  return {
    runId: a.runId,
    taskId: a.taskId,
    mode: a.mode,
    lifecycle: outcome.lifecycle,
    facts: outcome,
    winner: null,
    runDir: a.paths.root,
    summary,
    candidates: [],
    spendUsd,
  };
}
