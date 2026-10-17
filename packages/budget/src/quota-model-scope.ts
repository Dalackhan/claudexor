import { quotaModelPrefixMatches, type QuotaConstraint } from "@claudexor/schema";

/** Canonical admission predicate. Null model uses the vendor default's scope;
 * undefined has no model context and preserves conservative matching. */
export function quotaConstraintAppliesToModel(
  constraint: Pick<
    QuotaConstraint,
    "applies_to_models" | "applies_to_model_prefixes" | "applies_to_unspecified_model"
  >,
  model?: string | null,
): boolean {
  const scopedModels = constraint.applies_to_models;
  const prefixes = constraint.applies_to_model_prefixes;
  if ((scopedModels == null && !prefixes?.length) || model === undefined) return true;
  if (model === null) return constraint.applies_to_unspecified_model === true;
  return scopedModels?.includes(model) === true || quotaModelPrefixMatches(prefixes, model);
}
