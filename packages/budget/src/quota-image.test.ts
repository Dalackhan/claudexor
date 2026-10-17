import { describe, expect, it } from "vitest";
import { HarnessEvent } from "@claudexor/schema";
import { BudgetLedger } from "./ledger.js";
import { observationsFromEvent } from "./observe.js";
describe("image quota on ordinary agent budget rails", () => {
  it("preserves incremental image scope without cooling or pacing text", () => {
    const event = HarnessEvent.parse({
      type: "status",
      ts: new Date().toISOString(),
      session_id: "fixture",
      credential_route: "vendor_native",
      credential_profile_id: "work",
      quota: {
        source: "codex_app_server_event",
        subject_id: "work",
        plan_label: null,
        constraints: [
          {
            id: "image_gen:primary",
            label: "Images",
            applies_to_request_kinds: ["image"],
            used_ratio: 1,
            window_seconds: 60,
            resets_at: "2099-01-01T00:00:00Z",
          },
        ],
      },
    });
    const observations = observationsFromEvent("codex", event);
    expect(observations[0]?.applies_to_request_kinds).toEqual(["image"]);
    const ledger = new BudgetLedger();
    for (const observation of observations) ledger.observe(observation);
    expect(ledger.cooldownActive("codex", "vendor_native", "work")).toBe(false);
    expect(ledger.bindingPaceSlack("codex", "vendor_native", "work")).toBeNull();
  });
});
