import { z } from "zod/v3";
import { NonBlankString } from "./primitives.js";
import { ProcessingCapability } from "./processing.js";

/**
 * One enumerable model offered by a harness. Deliberately small: only the
 * fields a real enumeration source (an OpenAI-compatible `GET /v1/models`)
 * can honestly populate. `label`/`context_window` are nullable because the
 * raw `{data:[{id}]}` list rarely carries them.
 */
export const HarnessModel = z
  .object({
    processing: ProcessingCapability.optional(),
    id: z.string().describe("Model id as the vendor enumerates it."),
    label: z
      .string()
      .nullable()
      .default(null)
      .describe("Human-readable model label; null when the enumeration source has none."),
    context_window: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe("Context window in tokens; null when the enumeration source does not report it."),
    /** Credential routes the model is scoped to per the manifest annotation;
     * null = unannotated (available on every route). */
    routes: z
      .array(z.enum(["local_session", "api_key"]))
      .nullable()
      .default(null)
      .describe("Credential routes the model is scoped to; null = every route."),
    /** Row provenance inside ONE producer's answer. Absent = live, so producers
     * that predate the field (codex, cursor, raw-api) need no change. */
    origin: z
      .enum(["live", "hint"])
      .optional()
      .describe(
        "Where this row came from: live = the vendor's own enumeration reported it; hint = a frozen known-model id the producer appends when its live answer lacks it or could not be read. Absent = live.",
      ),
    /** What an alias row resolved to when the vendor was asked (claude's
     * `default` -> `claude-opus-5-5[1m]`). Diagnostic only: the row id is what
     * travels, never rewritten to this. */
    resolved_model: z
      .string()
      .nullable()
      .optional()
      .describe(
        "For an alias row, the exact model id the vendor reported it resolves to at enumeration time; null or absent when the source reports none. The row id is what is sent; this is never substituted for it.",
      ),
  })
  .describe(
    "One enumerable model offered by a harness, limited to fields a real enumeration source can honestly populate.",
  );
export type HarnessModel = z.infer<typeof HarnessModel>;

/**
 * Proof that a stream-observed model string names one listed model. Cursor's
 * stream reports the vendor's display label ("GPT-5.5 High") while runs request
 * the listed id; the observed string itself is never rewritten. A match exists
 * only when the same spawn's own account catalog lists exactly one live entry
 * whose label is byte-identical to the string and no other entry uses the
 * string as its id. Absence means no proof, never a mismatch.
 */
export const ObservedModelCatalogMatch = z
  .object({
    label: NonBlankString.describe(
      "The observed model string, byte-identical to observed_model on the same event and to the matched entry's catalog label.",
    ),
    id: NonBlankString.describe(
      "Id of the only catalog entry whose label is exactly `label`; no other entry has `label` as its id.",
    ),
    source: z
      .enum(["account_catalog"])
      .describe("The model list the spawn's own account answered before the vendor process ran."),
    // A fresh instance, not the shared Id: generated schemas inline it
    // instead of re-anchoring existing $refs on this field.
    profile_id: z
      .string()
      .min(1)
      .nullable()
      .describe(
        "Credential profile whose catalog answered (the spawn's profile); null = engine-default credentials.",
      ),
  })
  .strict()
  .describe(
    "Exact same-spawn catalog evidence mapping an observed model label to its listed id; never derived from the requested model, normalized or fuzzy-matched.",
  );
export type ObservedModelCatalogMatch = z.infer<typeof ObservedModelCatalogMatch>;

/** HarnessEvent model identity: the vendor's raw string and its catalog proof. */
export const ObservedModelEventFields = {
  observed_model: z.string().optional().describe("Model the harness actually reported using."),
  observed_model_catalog_match: ObservedModelCatalogMatch.optional().describe(
    "Stamped by the per-spawn model gate from that spawn's own account catalog; adapters never set it, and the gate strips any value it did not compute.",
  ),
};

/** Attempt model identity: the first disclosed string and the proof of that same event. */
export const AttemptObservedModelFields = {
  observed_model: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "Model the harness stream actually reported; null when never disclosed (rendered as unverified, never guessed).",
    ),
  observed_model_catalog_match: ObservedModelCatalogMatch.nullable()
    .default(null)
    .describe(
      "Catalog proof carried by the same event that set observed_model, kept only while no later native try of the attempt started and no later event reported another model; null otherwise, even if a later try's event carried one.",
    ),
};
