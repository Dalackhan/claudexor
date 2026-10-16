import { describe, expect, it } from "vitest";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { UsageCostTracker } from "../../budget/src/usage-evidence.js";
import { decorateCodexEvent, type CodexEventDecoration } from "./event-decoration.js";
import { codexProcessingCost, legacyCodexProcessing } from "./processing.js";

describe("Codex Fast allowance is not an observed debit receipt", () => {
  it.each(["tokens", "none", "valuation", "cash"])(
    "keeps actual cash honest for %s evidence",
    (evidence) => {
      const processing = legacyCodexProcessing("fast");
      const context: CodexEventDecoration = {
        spec: HarnessRunSpec.parse({
          session_id: "s",
          intent: "explain",
          prompt: "test",
          cwd: "/fixture",
          evidence_policy: "stream_only",
          processing,
          processing_cost_basis: codexProcessingCost(processing, true),
        }),
        env: {},
        credentialRoute: "vendor_native",
        credentialSource: "native_session",
        tempCodexHome: null,
        model: null,
      };
      expect(context.spec.processing_cost_basis?.kind).toBe("included");
      const events: HarnessEvent[] = [
        { type: "started", session_id: "s", ts: new Date().toISOString() },
      ];
      if (evidence !== "none")
        events.push({
          type: "usage",
          session_id: "s",
          ts: new Date().toISOString(),
          usage:
            evidence === "tokens"
              ? { input_tokens: 100, output_tokens: 10 }
              : {
                  cost_usd: 0.02,
                  cost_basis: {
                    kind: evidence === "cash" ? "cash" : "valuation",
                    source: "fixture.receipt",
                  },
                },
        });
      events.push({ type: "completed", session_id: "s", ts: new Date().toISOString() });
      const tracker = new UsageCostTracker();
      tracker.startAttempt();
      for (const raw of events) {
        const event = decorateCodexEvent(raw, context);
        tracker.observeEvent("local_session", event);
        if (event.usage?.cost_usd !== undefined)
          tracker.observeUsage("local_session", event.usage.cost_usd, false, event);
      }
      tracker.finishAttempt();
      expect(tracker.snapshot().cashKnowledge).toBe(evidence === "cash" ? "exact" : "unknown");
      expect(tracker.totals.cashUsd).toBe(evidence === "cash" ? 0.02 : 0);
      expect(tracker.totals.valuationUsd).toBe(evidence === "valuation" ? 0.02 : 0);
      expect(context.spec.processing_cost_basis?.kind).toBe("included");
    },
  );
});
