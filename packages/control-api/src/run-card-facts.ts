import {
  PlanQuestionsArtifact,
  derivePlanReadiness,
  RunFailure,
  isTerminalLifecycle,
  outcomeFactsFromFailure,
  type DecisionRecord,
  type RunOutcomeFacts,
  type WorkState,
} from "@claudexor/schema";
import type { DaemonRunRecord } from "./run-record.js";
import { safeReadStructuredArtifact } from "./run-artifact-read.js";
export function readFailure(rec: DaemonRunRecord, maxBytes?: number): RunFailure | null {
  const fromArtifact = safeReadStructuredArtifact(rec, "final/failure.yaml", RunFailure, maxBytes);
  if (fromArtifact) return fromArtifact;
  if (!rec.error) return null;
  return RunFailure.parse({
    category: "unknown",
    safeMessage: rec.error,
    runDir: rec.runDir ?? null,
  });
}

export function strategyFromParams(
  p: Record<string, unknown>,
): "race" | "attempts" | "until_clean" | "deep_scan" | "create" | null {
  if (p["untilClean"] === true) return "until_clean";
  if (typeof p["attempts"] === "number" && p["attempts"] > 0) return "attempts";
  if (p["create"] === true) return "create";
  if (p["deepScan"] === true) return "deep_scan";
  if (typeof p["n"] === "number" && p["n"] > 1) return "race";
  return null;
}

export function legacyRunOutcomeFacts(
  rec: DaemonRunRecord,
  decision: DecisionRecord | null,
  failure: RunFailure | null,
  workState: WorkState | null = null,
): RunOutcomeFacts | null {
  if (!isTerminalLifecycle(rec.state)) return null;
  // Arbitrated runs already carry work_state on decision.facts (INV-116).
  if (decision) return decision.facts;
  const lifecycle = rec.state as RunOutcomeFacts["lifecycle"];
  const base = outcomeFactsFromFailure(lifecycle, failure?.category);
  if (!workState || lifecycle !== "succeeded") return base;
  const vetoed = workState.state === "needs_input" || workState.state === "incomplete";
  return {
    ...base,
    work_state: workState,
    ...(vetoed
      ? {
          reason:
            base.reason ??
            (workState.state === "needs_input" ? "input_required" : "work_incomplete"),
        }
      : {}),
  };
}

export function planProjectionFor(
  rec: DaemonRunRecord,
  mode: string | null | undefined,
  maxBytes?: number,
) {
  const empty = { readiness: null, questions: [] };
  if (mode !== "plan" || !rec.runDir) return empty;
  const a = safeReadStructuredArtifact(
    rec,
    "final/questions.json",
    PlanQuestionsArtifact,
    maxBytes,
  );
  return a ? { readiness: derivePlanReadiness(a), questions: a.questions } : empty;
}
