import {
  ControlBudgetSnapshot,
  PaidBudget,
  TaskContract,
  type DecisionRecord,
} from "@claudexor/schema";
import { paramsRecord, type DaemonRunRecord } from "./run-record.js";
import { safeReadStructuredArtifact } from "./run-artifact-read.js";
import {
  budgetValuationFromEvents,
  cashEstimatedFromLedgerEvent,
  cashKnowledgeFromEvents,
  controllableSpendFromEvents,
  decisionCashAnchor,
  normalizeLegacyBudgetComponents,
} from "./budget-valuation.js";
import {
  readRunEvents,
  eventPayload,
  evidenceLevel,
  type RunEventsIntegrity,
} from "./run-timeline.js";
export function budgetSnapshot(
  rec: DaemonRunRecord,
  decision: DecisionRecord | null,
  eventsSnapshot?: Record<string, unknown>[],
  integrity?: RunEventsIntegrity,
  maxBytes?: number,
): ControlBudgetSnapshot {
  const p = paramsRecord(rec);
  // The ENGINE-EFFECTIVE cap lives in the immutable contract (request input,
  // surface default, or the configured global per-run default); request params
  // alone under-report a config-defaulted cap as "no cap".
  const contractBudget = safeReadStructuredArtifact(
    rec,
    "context/task.yaml",
    TaskContract,
    maxBytes,
  )?.budget.paid_budget;
  const paidBudget = PaidBudget.safeParse(p["paidBudget"]).data ??
    contractBudget ?? { kind: "unlimited" as const };
  const evs = eventsSnapshot ?? readRunEvents(rec);
  const anchor = decisionCashAnchor(decision?.budget_summary);
  let spendUsd = anchor.spendUsd;
  let estimated = decision?.budget_summary?.estimated ?? false;
  let source: "decision" | "events" | "settings" | "unknown" =
    spendUsd === null ? "unknown" : "decision";
  // Subscription VALUATION (QA-023c/QA-017b) beside cash — computed by the pure
  // event fold so an UNKNOWN valuation stays null, never a fabricated $0.
  const normalized = normalizeLegacyBudgetComponents(
    decision?.budget_summary ?? null,
    evs,
    budgetValuationFromEvents(evs),
  );
  let { valuationUsd, valuationKnowledge } = normalized;
  estimated = normalized.cashEstimated;
  if (spendUsd === null) {
    // The CASH truth for a decision-less run (plan/ask/explore — they never
    // write a decision record) is the ledger's own `budget.cash` disclosure:
    // cumulative, last-wins, subscription work settles to 0 there (W4.3).
    // budget.observation ticks are vendor VALUATION — for a subscription run
    // they are NON-ZERO while the cash truth is $0.00, so summing them as
    // spend showed valuation under a "real money" label (F4 review lane 1).
    // They remain only as the LEGACY fallback for runs predating budget.cash
    // (every new run settles at least once), disclosed as estimated.
    let lastCash: number | null = null;
    let observationSpend = 0;
    let sawObservation = false;
    let observationEstimated = false;
    let eventSpend = 0;
    let sawCost = false;
    let sawUsage = false;
    for (const ev of evs) {
      const payload = eventPayload(ev);
      if (ev["type"] === "budget.cash") {
        const cash = payload["cash_spend_usd"];
        if (typeof cash === "number" && Number.isFinite(cash)) {
          lastCash = cash;
          estimated = cashEstimatedFromLedgerEvent(payload);
        }
        continue;
      }
      if (ev["type"] === "budget.observation" && payload["kind"] === "spend") {
        const usd = payload["usd"];
        if (typeof usd === "number" && Number.isFinite(usd)) {
          observationSpend += usd;
          sawObservation = true;
        }
        if (payload["estimated"] === true) observationEstimated = true;
        continue;
      }
      if (ev["type"] !== "harness.event") continue;
      const usage = payload["usage"];
      if (usage && typeof usage === "object" && !Array.isArray(usage)) {
        sawUsage = true;
        const cost = (usage as Record<string, unknown>)["cost_usd"];
        if (typeof cost === "number" && Number.isFinite(cost)) {
          eventSpend += cost;
          sawCost = true;
        }
        if ((usage as Record<string, unknown>)["estimated"] === true) observationEstimated = true;
      }
    }
    if (lastCash !== null) {
      spendUsd = lastCash;
      source = "events";
    } else if (sawObservation) {
      spendUsd = observationSpend;
      source = "events";
      estimated = true; // valuation-derived: at best an estimate of cash
    } else if (sawCost) {
      spendUsd = eventSpend;
      source = "events";
      estimated = true;
    } else if (sawUsage) {
      source = "events";
    }
    if (observationEstimated && lastCash === null) estimated = true;
  }
  const cashKnowledge = cashKnowledgeFromEvents(evs);
  const controllableSpendUsd = controllableSpendFromEvents(evs, spendUsd);
  if (cashKnowledge === "unknown" || anchor.totalUnknown) spendUsd = null;
  if (cashKnowledge !== undefined) estimated = cashKnowledge !== "exact";
  const remainingUsd =
    paidBudget.kind === "finite" && controllableSpendUsd !== null
      ? Math.max(0, paidBudget.maxUsd - controllableSpendUsd)
      : null;
  // Disclose when the spend fallback read incomplete/unreadable canonical
  // events (QA-074): a partial event set can silently drop a spend tick, so the
  // projected spend must never present as clean when its evidence was not.
  const evidence = integrity ? evidenceLevel(integrity) : "complete";
  return ControlBudgetSnapshot.parse({
    cashKnowledge,
    paidBudget,
    spendUsd,
    controllableSpendUsd,
    valuationUsd,
    valuationKnowledge,
    remainingUsd,
    estimated,
    source,
    evidence,
  });
}
