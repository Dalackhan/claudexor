import { describe, expect, it } from "vitest";
import { UsageCostTracker, usageAmountKind } from "./usage-evidence.js";
import { BudgetLedger } from "./ledger.js";
import { attemptUsageCostSettlement, reviewUsageCostSettlement } from "./settlements.js";
import type { HarnessEvent, ProcessingCostBasis, ProcessingReceipt } from "@claudexor/schema";

const receipt = (mode: "standard" | "fast"): ProcessingReceipt => ({
  requested: mode,
  submitted: mode,
  submittedNative: mode,
  observed: "unknown",
  observedNative: [],
  reason: null,
  source: "fixture",
});
const basis = (kind: ProcessingCostBasis["kind"]): ProcessingCostBasis => ({
  kind,
  nativeMode: null,
  source: "fixture",
});
function event(
  processing: ProcessingReceipt,
  kind: ProcessingCostBasis["kind"],
  amount?: "cash" | "valuation" | "unknown",
): HarnessEvent {
  return {
    type: "usage",
    session_id: "s",
    ts: new Date().toISOString(),
    credential_route: "vendor_native",
    processing,
    processing_cost_basis: basis(kind),
    usage: { cost_usd: 2, ...(amount ? { cost_basis: { kind: amount, source: "fixture" } } : {}) },
  };
}
function observe(tracker: UsageCostTracker, ev: HarnessEvent) {
  tracker.observeEvent("local_session", ev);
  tracker.observeUsage("local_session", ev.usage!.cost_usd!, false, ev);
}

describe("processing-aware usage evidence", () => {
  it("preserves legacy native valuation but never infers premium cash or credit debit from its tariff", () => {
    expect(usageAmountKind("local_session", undefined)).toBe("valuation");
    expect(
      usageAmountKind("local_session", undefined, receipt("fast"), basis("paid_credits")),
    ).toBe("unknown");
    expect(usageAmountKind("api_key", undefined, receipt("fast"), basis("cash"))).toBe("cash");
    expect(
      usageAmountKind(
        "local_session",
        { kind: "valuation", source: "native-list" },
        receipt("fast"),
        basis("paid_credits"),
      ),
    ).toBe("valuation");
  });

  it("treats an omitted native processing control as ordinary included work", () => {
    const omitted: ProcessingReceipt = {
      requested: null,
      submitted: null,
      submittedNative: null,
      observed: "unknown",
      observedNative: [],
      reason: "native_default_unconfirmed",
      source: "fixture",
    };
    expect(usageAmountKind("local_session", undefined, omitted, basis("unknown"))).toBe(
      "valuation",
    );
  });
  it.each(["fast", "mixed"] as const)(
    "does not relabel submitted standard when observed mode is %s",
    (observed) => {
      expect(
        usageAmountKind(
          "local_session",
          undefined,
          {
            ...receipt("standard"),
            observed,
          },
          basis("unknown"),
        ),
      ).toBe("unknown");
    },
  );

  it.each(["valuation", "unknown"] as const)(
    "premium %s amount leaves actual paid consumption unknown at finite settlement",
    (amount) => {
      const tracker = new UsageCostTracker();
      tracker.startAttempt();
      observe(tracker, event(receipt("fast"), "paid_credits", amount));
      tracker.finishAttempt();
      expect(tracker.snapshot().cashKnowledge).toBe("unknown");
      expect(tracker.totals.cashUsd).toBe(0);
      const ledger = new BudgetLedger({ kind: "finite", maxUsd: 3 });
      const lease = ledger.reserve({
        taskId: "t",
        intent: "review",
        harnessId: "claude",
        cost: {
          knowledge: "unknown",
          billing: "metered",
          source: "fixture",
          provenance: ["fixture"],
          estimatedUsd: null,
          processing: basis("paid_credits"),
        },
      }).lease!;
      ledger.settle(
        lease.lease_id,
        reviewUsageCostSettlement(
          tracker.totals.cashUsd,
          tracker.totals.valuationUsd,
          {
            cash: tracker.snapshot().cashKnowledge,
            valuation: tracker.snapshot().valuationKnowledge,
          },
          ["fixture"],
          tracker.totals.unknownUsd,
        ),
      );
      expect(ledger.spend()).toBe(0);
      expect(ledger.terminal()).toBe("cost_unverifiable");
    },
  );

  it("ordinary included billing proves zero cash independently of an unknown scalar amount", () => {
    const tracker = new UsageCostTracker();
    tracker.startAttempt();
    observe(tracker, event(receipt("standard"), "included", "unknown"));
    tracker.finishAttempt();
    expect(tracker.snapshot()).toEqual({
      cashKnowledge: "exact",
      valuationKnowledge: "unknown",
      allowanceDebitUnobserved: false,
    });
    expect(tracker.totals.unknownUsd).toBe(2);
    expect(tracker.unknownPaidUsd).toBe(0);
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 0 });
    const lease = ledger.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "claude",
      cost: {
        knowledge: "exact",
        billing: "subscription_entitlement",
        source: "fixture",
        provenance: ["fixture"],
        estimatedUsd: null,
      },
    }).lease!;
    ledger.settle(
      lease.lease_id,
      attemptUsageCostSettlement(2, false, "a", "claude", "local_session", {
        ...tracker.totals,
        ...tracker.snapshot(),
      }),
    );
    expect(ledger.spend()).toBe(0);
    expect(ledger.terminal()).toBeNull();
  });

  it("retains an unpriced premium interval across a successful ordinary retry", () => {
    const tracker = new UsageCostTracker();
    tracker.startAttempt();
    tracker.observeEvent("local_session", event(receipt("fast"), "paid_credits"));
    tracker.startAttempt();
    observe(tracker, event(receipt("standard"), "included", "valuation"));
    tracker.finishAttempt();
    expect(tracker.snapshot().cashKnowledge).toBe("unknown");
    expect(tracker.totals.valuationUsd).toBe(2);
  });

  it("does not let an earlier API receipt certify a later premium or mixed interval", () => {
    const tracker = new UsageCostTracker();
    tracker.startAttempt();
    tracker.observeEvent("api_key");
    tracker.observeUsage("api_key", 0.25, false);
    tracker.observeEvent(
      "local_session",
      event({ ...receipt("fast"), observed: "mixed" }, "unknown"),
    );
    tracker.finishAttempt();
    expect(tracker.totals.cashUsd).toBe(0.25);
    expect(tracker.snapshot().cashKnowledge).toBe("unknown");
  });
});
