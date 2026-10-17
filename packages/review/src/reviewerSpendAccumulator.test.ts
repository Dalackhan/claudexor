import { describe, expect, it } from "vitest";
import { ReviewerSpendAccumulator } from "./reviewerSpendAccumulator.js";
import type { ReviewerOutput } from "./reviewRuntimeTypes.js";

const output = (allowanceDebitUnobserved?: boolean): ReviewerOutput => ({
  text: "",
  observedSource: "stream_event",
  costUsd: 0,
  costEstimated: false,
  cashUsd: 0,
  valuationUsd: 0,
  unknownUsd: 0,
  cashKnowledge: "exact",
  valuationKnowledge: "unknown",
  ...(allowanceDebitUnobserved === undefined ? {} : { allowanceDebitUnobserved }),
});

describe("reviewer panel spend keeps an unobserved allowance debit", () => {
  it("reports the panel debit unobserved when any finished or partial slot says so", () => {
    const finished = new ReviewerSpendAccumulator(2);
    finished.record(0, output());
    finished.record(1, output(true));
    expect(finished.summary()).toMatchObject({
      reviewCashKnowledge: "exact",
      reviewAllowanceDebitUnobserved: true,
    });
    const partial = new ReviewerSpendAccumulator(2);
    partial.record(0, output(false));
    partial.recordPartial(1, {
      partialCashKnowledge: "exact",
      partialAllowanceDebitUnobserved: true,
    });
    expect(partial.summary().reviewAllowanceDebitUnobserved).toBe(true);
    const ordinary = new ReviewerSpendAccumulator(1);
    ordinary.record(0, output());
    expect(ordinary.summary().reviewAllowanceDebitUnobserved).toBe(false);
  });
});
