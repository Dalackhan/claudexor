import { expect, it } from "vitest";
import { parseCodexRateLimitsResponse, codexRateLimitEvents } from "./quota.js";
it("keeps known image windows visible from either full or incremental wire without guessing unknown applicability", () => {
  const primary = { usedPercent: 100, windowDurationMins: 1440, resetsAt: 1900003600 };
  for (const value of [
    { rateLimits: { limitId: "image_gen", primary } },
    { rateLimitsByLimitId: { image_gen: { primary } } },
  ]) {
    expect(parseCodexRateLimitsResponse(value, new Date(), "work")[0]?.constraints).toMatchObject([
      { id: "image_gen:primary", applies_to_request_kinds: ["image"], used_ratio: 1 },
    ]);
    expect(codexRateLimitEvents(value, "fixture")[0]?.quota?.constraints).toMatchObject([
      { applies_to_request_kinds: ["image"] },
    ]);
  }
  const unknown = { rateLimits: { limitId: "unmapped", primary } };
  expect(parseCodexRateLimitsResponse(unknown, new Date())[0]?.constraints).toEqual([]);
  expect(codexRateLimitEvents(unknown, "fixture")[0]?.payload?.native_quota).toMatchObject({
    applicability: "unknown",
    used_ratio: 1,
  });
  expect(() =>
    parseCodexRateLimitsResponse(
      { rateLimits: { limitId: "image_gen", primary: { usedPercent: "bad" } } },
      new Date(),
    ),
  ).toThrow();
});
