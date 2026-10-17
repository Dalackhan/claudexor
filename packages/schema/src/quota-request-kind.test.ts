import { describe, expect, it } from "vitest";
import {
  QuotaConstraint,
  quotaConstraintIdentity,
  quotaSnapshotAvailability,
  withQuotaAvailability,
} from "./quota.js";
const window = QuotaConstraint.parse({
  id: "same",
  label: "Window",
  used_ratio: 1,
  window_seconds: 60,
  resets_at: "2099-01-01T00:00:00Z",
});
describe("quota request-kind applicability", () => {
  it("keeps legacy scope and independent model scope while distinguishing modality identities", () => {
    const image = { ...window, applies_to_request_kinds: ["image"] as const };
    const scoped = QuotaConstraint.parse(image);
    expect(quotaSnapshotAvailability({ constraints: [scoped] }).state).toBe("available");
    expect(
      quotaSnapshotAvailability({ constraints: [scoped] }, { requestKind: "image" }).state,
    ).toBe("exhausted");
    expect(
      quotaSnapshotAvailability({ constraints: [window] }, { requestKind: "image" }).state,
    ).toBe("exhausted");
    expect(
      quotaSnapshotAvailability(
        { constraints: [{ ...scoped, applies_to_models: ["image-a"] }] },
        { model: "image-b", requestKind: "image" },
      ).state,
    ).toBe("available");
    expect(quotaConstraintIdentity(scoped)).not.toBe(quotaConstraintIdentity(window));
    expect(quotaConstraintIdentity(scoped)).not.toBe(
      quotaConstraintIdentity({ ...window, applies_to_request_kinds: ["text"] }),
    );
    expect(QuotaConstraint.safeParse({ ...window, applies_to_request_kinds: [] }).success).toBe(
      false,
    );
  });
  it("keeps image evidence visible in default Accounts projection", () => {
    const raw = {
      snapshots: [
        {
          subject: {
            harness: "codex",
            credential_route: "vendor_native" as const,
            plan_label: null,
            subject_id: "a",
          },
          constraints: [{ ...window, applies_to_request_kinds: ["image" as const] }],
          source: "codex_app_server" as const,
          observed_at: new Date().toISOString(),
          freshness: "fresh" as const,
        },
      ],
      absences: [],
      refreshed_at: null,
    };
    const text = withQuotaAvailability(raw);
    expect(text.snapshots[0]!.constraints).toEqual(raw.snapshots[0]!.constraints);
    expect(text.snapshots[0]!.availability?.state).toBe("available");
    expect(
      withQuotaAvailability(raw, { requestKind: "image" }).snapshots[0]!.availability?.state,
    ).toBe("exhausted");
  });
});
