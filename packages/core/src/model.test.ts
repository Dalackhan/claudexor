import { describe, expect, it } from "vitest";
import { HarnessModel } from "@claudexor/schema";
import { hasModelInventoryForRoute, observedModelCatalogMatch, validateModel } from "./model.js";

describe("validateModel under an AUTHORITATIVE declaration (strict model truth)", () => {
  const known = ["sonnet", "opus", "claude-opus-4-8"];

  it("is ok when no model is requested (the harness default is used)", () => {
    expect(validateModel(null, known, "manifest", "authoritative").status).toBe("ok");
    expect(validateModel(undefined, known, "manifest", "authoritative").status).toBe("ok");
    expect(validateModel("", known, "manifest", "authoritative").status).toBe("ok");
  });

  it("is ok for a known alias/id", () => {
    expect(validateModel("opus", known, "manifest", "authoritative").status).toBe("ok");
    expect(validateModel("claude-opus-4-8", known, "manifest", "authoritative").status).toBe("ok");
    expect(validateModel("  opus  ", known, "manifest", "authoritative").status).toBe("ok"); // trimmed
  });

  it("REJECTS an explicit model when the harness has no truth list (never forwarded to die natively)", () => {
    const manifest = validateModel("anything", [], "manifest", "authoritative");
    expect(manifest.status).toBe("rejected");
    expect(manifest.message).toContain("cannot verify models");
    expect(manifest.message).toContain("manifest known_models");
    const api = validateModel("anything", [], "api", "authoritative");
    expect(api.status).toBe("rejected");
    expect(api.message).toContain("live model inventory");
    expect(api.message).toContain("repair the live account/auth route");
    expect(api.message).not.toContain("known_models");
  });

  it("REJECTS a miss naming the truth source and the list (the fable regression, now typed)", () => {
    const r = validateModel("fable-x", known, "manifest", "authoritative");
    expect(r.status).toBe("rejected");
    expect(r.message).toContain('model "fable-x"');
    expect(r.message).toContain("manifest known-model list");
    expect(r.message).toContain("sonnet");
  });

  it("REJECTS an api-inventory miss", () => {
    const r = validateModel("ghost", ["gpt-4o", "gpt-4o-mini"], "api", "authoritative");
    expect(r.status).toBe("rejected");
    expect(r.message).toContain("live model inventory");
  });

  it("truncates giant truth lists in the refusal message", () => {
    const big = Array.from({ length: 120 }, (_, i) => `m-${i}`);
    const r = validateModel("nope", big, "api", "authoritative");
    expect(r.status).toBe("rejected");
    expect(r.message).toContain("(120 total)");
  });
});

/**
 * An ADVISORY declaration (INV-104; owner-approved 2026-09-21 for a live
 * producer, 2026-09-24 for the harness as a whole): a harness that cannot
 * enumerate what its runtime accepts proves PRESENCE only. Absence stops being
 * a reason to refuse — the explicit model is forwarded to the vendor and the
 * note says so. The declaration is the harness's, so it governs its manifest
 * hint list exactly like its live answer; everything authoritative keeps
 * today's exact text.
 */
describe("validateModel under an ADVISORY declaration", () => {
  const stale = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.2"];

  it("FORWARDS a model the live list lacks, with the unverified note", () => {
    const r = validateModel("gpt-6-astra", stale, "api", "advisory");
    expect(r.status).toBe("ok");
    expect(r.unverified).toBe(true);
    expect(r.message).toBe(
      "model \"gpt-6-astra\" is not in this account's listed models; this harness's list " +
        "cannot prove a model is absent, so the request is forwarded to the vendor",
    );
  });

  it("FORWARDS on an empty live list (the second live failure mode), saying which case it is", () => {
    const r = validateModel("gpt-6-astra", [], "api", "advisory");
    expect(r.status).toBe("ok");
    expect(r.unverified).toBe(true);
    expect(r.message).toBe(
      "the harness returned no model list; this harness's list cannot prove a model is " +
        "absent, so the request is forwarded to the vendor",
    );
  });

  it("stays silent for a LISTED model: presence is proof, so there is nothing to disclose", () => {
    const r = validateModel("gpt-5.5", stale, "api", "advisory");
    expect(r.status).toBe("ok");
    expect(r.message).toBeNull();
    expect(r.unverified).toBeUndefined();
    const none = validateModel(null, stale, "api", "advisory");
    expect(none.status).toBe("ok");
    expect(none.message).toBeNull();
    expect(none.unverified).toBeUndefined();
  });

  it("governs the MANIFEST hint list the same way: a hint list is one day's memory of the same vendor menu", () => {
    const miss = validateModel("gpt-6-astra", stale, "manifest", "advisory");
    expect(miss.status).toBe("ok");
    expect(miss.unverified).toBe(true);
    expect(miss.message).toBe(
      'model "gpt-6-astra" is not in this harness\'s manifest known-model list; this ' +
        "harness's list cannot prove a model is absent, so the request is forwarded to the vendor",
    );
    const empty = validateModel("gpt-6-astra", [], "manifest", "advisory");
    expect(empty.status).toBe("ok");
    expect(empty.unverified).toBe(true);
    expect(empty.message).toBe(
      "the harness manifest lists no models; this harness's list cannot prove a model is " +
        "absent, so the request is forwarded to the vendor",
    );
    // Presence is still proof on the manifest side: nothing to disclose.
    expect(validateModel("gpt-5.5", stale, "manifest", "advisory")).toEqual({
      status: "ok",
      message: null,
    });
  });

  it("keeps the authoritative refusals byte-identical on both sources", () => {
    expect(validateModel("gpt-6-astra", stale, "api", "authoritative")).toEqual({
      status: "rejected",
      message:
        'model "gpt-6-astra" is not in the harness\'s live model inventory ' +
        "(gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.2)",
    });
    expect(validateModel("gpt-6-astra", stale, "manifest", "authoritative")).toEqual({
      status: "rejected",
      message:
        'model "gpt-6-astra" is not in the harness\'s manifest known-model list ' +
        "(gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.2)",
    });
    expect(validateModel("gpt-6-astra", [], "api", "authoritative")).toEqual({
      status: "rejected",
      message:
        "this harness cannot verify models (no live model inventory); repair the live " +
        "account/auth route or use the harness default (omit the model)",
    });
    expect(validateModel("gpt-6-astra", [], "manifest", "authoritative")).toEqual({
      status: "rejected",
      message:
        "this harness cannot verify models (no manifest known_models); use the harness " +
        "default (omit the model) or add known_models to the manifest",
    });
  });
});

describe("model inventory credential routes", () => {
  it("keeps legacy enumeration and queries scoped producers only on their declared routes", () => {
    const adapter = { models: async () => [] };
    expect(hasModelInventoryForRoute(adapter, undefined, "api_key")).toBe(true);
    expect(hasModelInventoryForRoute(adapter, ["local_session"], null)).toBe(false);
    expect(hasModelInventoryForRoute(adapter, ["local_session"], "local_session")).toBe(true);
    expect(hasModelInventoryForRoute(adapter, ["local_session"], "api_key")).toBe(false);
    expect(hasModelInventoryForRoute({}, ["local_session"], "local_session")).toBe(false);
  });
});

// Synthetic Cursor-style `--list-models` rows: no recorded real catalog/init pair exists.
describe("observedModelCatalogMatch (synthetic catalogs)", () => {
  const row = (id: string, label: string | null, origin?: "hint") =>
    HarnessModel.parse({ id, label, ...(origin ? { origin } : {}) });
  const catalog = [
    row("gpt-5.5-high", "GPT-5.5 High"),
    row("gpt-5.5-high-fast", "GPT-5.5 High Fast"),
    row("gpt-5.5", "GPT-5.5"),
    row("auto", "auto"),
    row("unlabelled-model", null),
  ];

  it("names the only row whose label is byte-identical, keeping full speed/effort variants", () => {
    expect(observedModelCatalogMatch("GPT-5.5 High", catalog, null)).toEqual({
      label: "GPT-5.5 High",
      id: "gpt-5.5-high",
      source: "account_catalog",
      profile_id: null,
    });
    expect(observedModelCatalogMatch("GPT-5.5 High Fast", catalog, "cursor-work")).toEqual({
      label: "GPT-5.5 High Fast",
      id: "gpt-5.5-high-fast",
      source: "account_catalog",
      profile_id: "cursor-work",
    });
    // A row may legitimately carry its own id as its label.
    expect(observedModelCatalogMatch("auto", catalog, null)?.id).toBe("auto");
  });

  it("is no proof without exact equality: no trim, case-fold, spacing or id-as-label reading", () => {
    for (const observed of [
      "gpt-5.5 high",
      "GPT-5.5 HIGH",
      " GPT-5.5 High",
      "GPT-5.5 High ",
      "GPT-5.5  High",
      "GPT-5.5-High",
      "GPT-5.5 Hi",
      // A listed id is not a label: the raw observed string already names it.
      "gpt-5.5-high",
      "unlabelled-model",
    ])
      expect(observedModelCatalogMatch(observed, catalog, null)).toBeNull();
  });

  it("is no proof when the label is ambiguous or collides with another row's id", () => {
    const duplicated = [...catalog, row("gpt-5.5-high-legacy", "GPT-5.5 High")];
    expect(observedModelCatalogMatch("GPT-5.5 High", duplicated, null)).toBeNull();
    const colliding = [row("composer-2", "Composer"), row("Composer", "Composer Legacy")];
    expect(observedModelCatalogMatch("Composer", colliding, null)).toBeNull();
  });

  it("is no proof from a hint row, an empty catalog, a blank string or an invalid profile id", () => {
    const hinted = [row("gpt-5.5-high", "GPT-5.5 High", "hint")];
    expect(observedModelCatalogMatch("GPT-5.5 High", hinted, null)).toBeNull();
    // A hint row still counts as an id collision: never weaker than the live rows.
    const shadowed = [row("Composer", null, "hint"), row("composer-2", "Composer")];
    expect(observedModelCatalogMatch("Composer", shadowed, null)).toBeNull();
    expect(observedModelCatalogMatch("GPT-5.5 High", [], null)).toBeNull();
    const blank = [row("blank-label", " "), row("empty-label", "")];
    expect(observedModelCatalogMatch(" ", blank, null)).toBeNull();
    expect(observedModelCatalogMatch("", blank, null)).toBeNull();
    expect(observedModelCatalogMatch("GPT-5.5 High", catalog, "")).toBeNull();
  });
});
