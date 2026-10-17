/** /v2/quota control services over the daemon's QuotaRegistry. */
import type { QuotaRegistry } from "@claudexor/daemon";
import {
  ControlQuotaFreshnessResponse,
  ControlAccountResourcesFreshnessResponse,
  ControlQuotaReadRequest,
  ControlQuotaRefreshRequest,
  withQuotaAvailability,
  type ControlQuotaResponse,
  type ControlAccountResourcesResponse,
  type AccountResourceSnapshot,
} from "@claudexor/schema";
import { accountManagementTarget } from "./account-management.js";

type AvailabilityScope = Pick<ControlQuotaRefreshRequest, "requestKind" | "model">;

export function accountResourcesResponse(
  registry: QuotaRegistry,
  response: ControlQuotaResponse = registry.read(),
  resources: AccountResourceSnapshot[] = registry.readResources(),
  scope: AvailabilityScope = {},
): ControlAccountResourcesResponse {
  return { ...withQuotaAvailability(response, scope), resources };
}

type DecoratedSnapshot = ControlQuotaResponse["snapshots"][number];

/** The historical Codex reset-credit label and the resets facet it came from. */
function resetCreditLabel(
  resources: readonly AccountResourceSnapshot[],
  snapshot: DecoratedSnapshot,
) {
  const row = resources.find(
    (row) =>
      row.target.harness === snapshot.subject.harness &&
      row.target.profile_id === snapshot.subject.subject_id,
  );
  const count = row?.resets.value?.find((offer) => offer.id === "codex_granted")?.available_count;
  return row && typeof count === "number" && count > 0 && snapshot.source === "codex_app_server"
    ? {
        facet: row.resets,
        constraint: {
          id: "reset_credits",
          label: `${count} reset credit${count === 1 ? "" : "s"} available`,
          used_ratio: null,
          window_seconds: null,
          resets_at: null,
          cooldown_until: null,
        },
      }
    : null;
}

function withResetCreditLabel<T extends object>(snapshot: DecoratedSnapshot, label: T) {
  return {
    ...snapshot,
    constraints: [
      ...snapshot.constraints.filter((constraint) => constraint.id !== "reset_credits"),
      label,
    ],
  };
}

/** Compatibility text belongs at the wire boundary, never in canonical quota
 * evidence or admission. The resources-only view keeps its existing semantics. */
export function legacyQuotaResponse(
  registry: QuotaRegistry,
  response: ControlQuotaResponse,
  resources = registry.readResources?.() ?? [],
  scope: AvailabilityScope = {},
): ControlQuotaResponse {
  const decorated = withQuotaAvailability(response, scope);
  return {
    ...decorated,
    snapshots: decorated.snapshots.map((snapshot) => {
      const credits = resetCreditLabel(resources, snapshot);
      return credits ? withResetCreditLabel(snapshot, credits.constraint) : snapshot;
    }),
  };
}

/** Opt-in display read: the legacy shape plus each window's own freshness.
 * The compatibility label is not a quota window: it carries the freshness of
 * the resets facet its count came from, never fresher than an unknown snapshot. */
export function constraintFreshnessQuotaResponse(
  registry: QuotaRegistry,
  scope: AvailabilityScope = {},
  resources = registry.readResources?.() ?? [],
): ControlQuotaFreshnessResponse {
  const decorated = withQuotaAvailability(registry.readConstraintFreshness(), scope);
  return ControlQuotaFreshnessResponse.parse({
    ...decorated,
    snapshots: decorated.snapshots.map((snapshot) => {
      const credits = resetCreditLabel(resources, snapshot);
      return credits
        ? withResetCreditLabel(snapshot, {
            ...credits.constraint,
            freshness: snapshot.freshness === "unknown" ? "unknown" : credits.facet.freshness,
          })
        : snapshot;
    }),
  });
}

/** Bind GET/POST /v2/quota to the registry. Both routes decorate each snapshot
 * with the derived model-aware availability projection at the response
 * boundary; the registry's own read()/journal/projection-signature stay
 * byte-identical. The atomic Accounts response uses the same decorator at its
 * own boundary. POST accepts an optional model to compute state against. */
export function quotaControlServices(quotaRegistry: () => QuotaRegistry) {
  return {
    quota: async (input?: ControlQuotaReadRequest) => {
      const { view, ...scope } = ControlQuotaReadRequest.parse(input ?? {});
      const registry = quotaRegistry();
      if (view === "resources_freshness") {
        const resources = registry.readResources();
        const response = constraintFreshnessQuotaResponse(registry, scope, resources);
        return ControlAccountResourcesFreshnessResponse.parse({
          ...response,
          resources,
          availability_scope: {
            basis: "quota_block",
            model: scope.model ?? null,
            requestKind: scope.requestKind ?? "text",
          },
        });
      }
      if (view === "resources")
        return accountResourcesResponse(registry, registry.read(), registry.readResources(), scope);
      if (view === "constraint_freshness") return constraintFreshnessQuotaResponse(registry, scope);
      return legacyQuotaResponse(registry, registry.read(), undefined, scope);
    },
    refreshQuota: async (input?: ControlQuotaRefreshRequest & { view?: "resources" }) => {
      const { view, ...body } = input ?? {};
      const request = ControlQuotaRefreshRequest.parse(body);
      if (request.target) accountManagementTarget(request.target);
      if (view === "resources") {
        const result = await quotaRegistry().refreshResources(request.target);
        return {
          ...withQuotaAvailability(result, request),
          resources: result.resources,
        };
      }
      return withQuotaAvailability(
        legacyQuotaResponse(quotaRegistry(), await quotaRegistry().refresh(request.target)),
        request,
      );
    },
  };
}
