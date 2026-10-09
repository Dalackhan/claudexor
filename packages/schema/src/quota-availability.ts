import {
  QuotaAvailability,
  quotaSnapshotIdentity,
  quotaConstraintAppliesToRequestKind,
  type QuotaSnapshot,
  type QuotaRequestKind,
  type QuotaModelScopedExhaustion,
  type ControlQuotaResponse,
} from "./quota.js";

/** Millisecond instant of a still-future ISO timestamp, else null. */
function futureMs(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at > now ? at : null;
}

/** Literal family matching belongs to the quota contract, shared by display
 * and admission. Prefixes must be declared by the vendor-specific producer;
 * neither a missing model nor an unknown family proves a match. */
export function quotaModelPrefixMatches(
  prefixes: readonly string[] | undefined,
  model: string,
): boolean {
  return prefixes?.some((prefix) => prefix.length > 0 && model.startsWith(prefix)) === true;
}

/** API-parameter model matching, deliberately looser than the router's exact
 * `quotaConstraintAppliesToModel` (@claudexor/budget): consumers pass whatever
 * model string they route with ("claude-fable-5", "fable", a bracketed
 * variant), while producers publish vendor alias lists — so match by
 * case-insensitive alias containment in either direction. A null/empty scope
 * list is a vendor-wide window and matches every model. */
function modelScopeMatches(scope: readonly string[] | null | undefined, model: string): boolean {
  if (scope == null || scope.length === 0) return true;
  const target = model.trim().toLowerCase();
  return scope.some((alias) => {
    const candidate = alias.trim().toLowerCase();
    return (
      candidate !== "" &&
      target !== "" &&
      (candidate.includes(target) || target.includes(candidate))
    );
  });
}

/** Derive one snapshot's typed model-aware availability — a pure projection
 * over the snapshot's own constraints, never an aggregate across subjects.
 * Blocking semantics mirror the router's `BudgetLedger`: a window
 * blocks while its cooldown_until is in the future, or while used_ratio >= 1
 * with a still-future resets_at (a spent ratio whose reset elapsed or is
 * unknown is stale data, not a live block). Without `model`, only windows that
 * apply to EVERY model can block; model-scoped spent windows are disclosed in
 * model_scoped_exhaustions and leave state available — including a spent
 * scoped window whose reset is UNKNOWN (disclosed with resets_at null, never
 * blocking); one whose reset ELAPSED is provably released and not disclosed.
 * With `model`, scoped windows matching it block too.
 * Full-coverage inference ("every model is
 * covered by some spent scoped window") is deliberately not attempted: the
 * model universe is unknowable here, so that case stays available + disclosed. */
export function quotaSnapshotAvailability(
  snapshot: Pick<QuotaSnapshot, "constraints">,
  opts: { now?: Date; model?: string | null; requestKind?: QuotaRequestKind } = {},
): QuotaAvailability {
  const now = (opts.now ?? new Date()).getTime();
  const model = opts.model ?? null;
  const blocking: string[] = [];
  const scopedExhaustions: QuotaModelScopedExhaustion[] = [];
  let sawExhausted = false;
  let earliestRelease: { iso: string; at: number } | null = null;
  for (const constraint of snapshot.constraints) {
    if (!quotaConstraintAppliesToRequestKind(constraint, opts.requestKind)) continue;
    const resetAt = futureMs(constraint.resets_at, now);
    const cooldownAt = futureMs(constraint.cooldown_until, now);
    const exhausted =
      constraint.used_ratio !== null && constraint.used_ratio >= 1 && resetAt !== null;
    const cooling = cooldownAt !== null;
    // A spent ratio with an UNKNOWN reset never blocks (BudgetLedger mirror:
    // stale data, not a live block), but a scoped one is still DISCLOSED below
    // with resets_at null; an elapsed reset is provably released and stays
    // undisclosed.
    const spentUnknownReset =
      constraint.used_ratio !== null && constraint.used_ratio >= 1 && constraint.resets_at === null;
    if (!exhausted && !cooling && !spentUnknownReset) continue;
    // A constraint stays blocked until EVERY active condition lifts, so its
    // own release is the LATER of the two; the snapshot-level resets_at below
    // is the EARLIEST such release across blocking constraints. A
    // disclosure-only window (spent, unknown reset) has no release instant.
    const release =
      !exhausted && !cooling
        ? null
        : exhausted && cooling
          ? (resetAt as number) >= (cooldownAt as number)
            ? { iso: constraint.resets_at as string, at: resetAt as number }
            : { iso: constraint.cooldown_until as string, at: cooldownAt as number }
          : exhausted
            ? { iso: constraint.resets_at as string, at: resetAt as number }
            : { iso: constraint.cooldown_until as string, at: cooldownAt as number };
    const scope = constraint.applies_to_models ?? null;
    const prefixes = constraint.applies_to_model_prefixes;
    const scoped = (scope !== null && scope.length > 0) || (prefixes?.length ?? 0) > 0;
    if (scoped) {
      scopedExhaustions.push({
        constraint_id: constraint.id,
        applies_to_models: [...(scope ?? [])],
        ...(prefixes?.length ? { applies_to_model_prefixes: [...prefixes] } : {}),
        resets_at: release?.iso ?? null,
      });
    }
    if (release === null) continue;
    // The projection and the router must answer the SAME question: a scoped
    // window that declares it governs the unspecified-model route blocks a
    // bare run, or the Accounts card would read "available" for an account the
    // router is already refusing.
    if (
      scoped &&
      (model === null
        ? constraint.applies_to_unspecified_model !== true
        : !(
            quotaModelPrefixMatches(prefixes, model) ||
            (scope !== null && scope.length > 0 && modelScopeMatches(scope, model))
          ))
    )
      continue;
    blocking.push(constraint.id);
    if (exhausted) sawExhausted = true;
    if (earliestRelease === null || release.at < earliestRelease.at) {
      earliestRelease = release;
    }
  }
  return QuotaAvailability.parse({
    state: blocking.length === 0 ? "available" : sawExhausted ? "exhausted" : "cooldown",
    blocking_constraints: blocking,
    resets_at: earliestRelease?.iso ?? null,
    model_scoped_exhaustions: scopedExhaustions,
  });
}

/** Decorate a quota response with per-snapshot availability projections —
 * applied at the /v2/quota and atomic Accounts response boundaries so
 * journals and raw projection signatures stay byte-identical. */
export function withQuotaAvailability(
  response: ControlQuotaResponse,
  opts: { now?: Date; model?: string | null; requestKind?: QuotaRequestKind } = {},
): ControlQuotaResponse {
  return {
    ...response,
    snapshots: response.snapshots.map((snapshot) => ({
      ...snapshot,
      snapshot_id: quotaSnapshotIdentity(snapshot),
      availability: quotaSnapshotAvailability(snapshot, opts),
    })),
  };
}
