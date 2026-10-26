import type { EventLog } from "@claudexor/event-log";
import { RoutePrimaryDivergedPayload as RoutePrimaryDivergedPayloadSchema } from "@claudexor/schema";

/** Disclose a requested or configured primary lost before dispatch. Browser
 * omissions carry their capability cause; existing pool/quota drops keep
 * their original classification. No-op when the primary remains ordered. */
export function emitPrimaryDivergence(
  log: EventLog | undefined,
  requested: string | undefined,
  ordered: { adapter: { id: string } }[],
  pool: { adapter: { id: string } }[],
  dropped: string[],
  browserOmissions: string[] = [],
): void {
  if (!log || !requested || ordered.some((r) => r.adapter.id === requested)) return;
  const survivedPool = pool.some((r) => r.adapter.id === requested);
  log.emit(
    "route.primary.diverged",
    RoutePrimaryDivergedPayloadSchema.parse({
      requested,
      effective: ordered[0]?.adapter.id ?? null,
      reason: browserOmissions.includes(requested)
        ? "capability_incompatible"
        : survivedPool
          ? "quota_exhausted"
          : "auth_unavailable",
      detail: survivedPool
        ? `${requested} is on cooldown or over its budget/quota pace`
        : (dropped.find((d) => d.startsWith(`${requested} `) || d.startsWith(`${requested}(`)) ??
          `${requested} is unavailable`),
    }) as unknown as Record<string, unknown>,
  );
}
