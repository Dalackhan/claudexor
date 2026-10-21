/** Candidate membership and exact-row readiness shared by requirements admission and execution. */
import type {
  GlobalConfig,
  Intent,
  CredentialProfile,
  CredentialProfileStatus,
  CredentialUnusableObservation,
} from "@claudexor/schema";
import { HarnessUnavailableError, type AdapterRegistry } from "@claudexor/core";
import type { HarnessStatus } from "@claudexor/gateway";
import { accountPoolRows } from "./account-pool.js";
import {
  selectedProfileAvailability,
  type VendorQuotaObservations,
} from "./credential-profiles.js";

export function resolveCandidateHarnessIds(args: {
  harnesses?: string[];
  credentialProfileId?: string | null;
  config: GlobalConfig;
  registry: AdapterRegistry;
  statuses: Array<
    Pick<HarnessStatus, "id" | "status" | "enabledIntents"> &
      Partial<Pick<HarnessStatus, "manifest">>
  >;
  intent: Intent;
}): string[] {
  const { config, registry, statuses, intent } = args;
  const input = args;
  const disabledHarnessIds = new Set(
    Object.entries(config.harnesses)
      .filter(([, settings]) => settings.enabled === false)
      .map(([id]) => id),
  );
  let ids = args.harnesses;
  if (!ids || ids.length === 0) {
    // INV-135: a profile names its enabled harness(es); its scoped probe is
    // authoritative even when the default store is logged out.
    const profilePool = input.credentialProfileId
      ? [
          ...new Set(
            (config.credential_profiles ?? [])
              .filter((p) => p.enabled && p.profile_id === input.credentialProfileId)
              .map((p) => p.harness_id)
              .filter((hid) => !disabledHarnessIds.has(hid) && registry.has(hid)),
          ),
        ]
      : [];
    if (profilePool.length > 0) {
      ids = profilePool;
    } else if (input.credentialProfileId) {
      // A named unknown/disabled profile refuses here; it never falls
      // through and runs on default credentials.
      const registered = (config.credential_profiles ?? []).filter(
        (p) => p.profile_id === input.credentialProfileId,
      );
      throw new HarnessUnavailableError(
        registered.length === 0
          ? `credential profile "${input.credentialProfileId}" is not registered (see \`claudexor profiles list\`)`
          : registered.every((p) => !p.enabled)
            ? `credential profile "${input.credentialProfileId}" is disabled`
            : `credential profile "${input.credentialProfileId}" belongs to unavailable harness(es): ${registered.map((p) => p.harness_id).join(", ")}`,
      );
    } else {
      // Auto-pools take doctor-OK default routes (BIBLE §2: doctor decides
      // default-route readiness; a key string or degraded route is visible
      // but not routable) PLUS harnesses with enabled account rows: the default
      // doctor only sees the default store, and a signed-in registry row is
      // invisible to it (cursor after the host-Keychain retirement, or a
      // named-rows-only claude/codex install). Row-bearing lanes still pass
      // the per-lane row probe below before they are admitted.
      const registry = config.credential_profiles ?? [];
      ids = statuses
        .filter(
          (s) =>
            s.manifest?.kind !== "fake" &&
            ((s.status === "ok" && s.enabledIntents.includes(intent)) ||
              accountPoolRows(registry, s.id).length > 0),
        )
        .map((s) => s.id);
      if (ids.length === 0) {
        throw new HarnessUnavailableError(
          "no doctor-OK default route or enabled account row for this mode; inspect `claudexor doctor` and `claudexor accounts`, or pass --harness explicitly",
        );
      }
    }
  }
  return ids;
}

/** Readiness admits only the pin, or the bound/pool rows when the default is unavailable. */
export async function admitCredentialRouteRows(args: {
  registry: readonly CredentialProfile[];
  profileId: string | null;
  boundProfileId: string | null;
  harnessId: string;
  defaultReady: boolean;
  model: string | null;
  quota: VendorQuotaObservations;
  unusable: readonly CredentialUnusableObservation[];
  probe: ((profile: CredentialProfile) => Promise<CredentialProfileStatus>) | undefined;
}): Promise<{ admitted: boolean; pinVerdict: string | null; unreadyRows: string | null }> {
  const { registry, harnessId, profileId: explicitPin, boundProfileId: bound } = args;
  const candidateIds: string[] = [];
  if (explicitPin) {
    candidateIds.push(explicitPin);
  } else if (!args.defaultReady) {
    const pool = accountPoolRows(registry, harnessId);
    candidateIds.push(
      ...(bound && pool.some((row) => row.profile_id === bound) ? [bound] : []),
      ...pool.map((row) => row.profile_id).filter((rowId) => rowId !== bound),
    );
  }
  const verdicts: string[] = [];
  let lastVerdict: string | null = null;
  for (const candidateId of candidateIds) {
    const verdict = await selectedProfileAvailability({
      registry,
      profileId: candidateId,
      harnessId,
      probe: args.probe,
      // `verification: passed` from the local store only means a login file
      // is present. The poller's authenticated vendor call is the only
      // liveness evidence; admission must act on it or dispatch may use a revoked token.
      quota: args.quota,
      unusable: args.unusable,
      model: args.model,
      // Only an explicit/bound route may consume bounded stale LKG evidence;
      // only an unpinned one may consume a last positive after a timeout.
      allowStale: explicitPin !== null || bound === candidateId,
      unpinned: explicitPin === null,
    });
    if (verdict === "available") return { admitted: true, pinVerdict: null, unreadyRows: null };
    lastVerdict = verdict;
    verdicts.push(`${candidateId}: ${verdict ?? "not ready"}`);
  }
  return {
    admitted: false,
    pinVerdict: explicitPin ? lastVerdict : null,
    unreadyRows:
      !explicitPin && verdicts.length > 0
        ? `${harnessId} has no ready account (${verdicts.join("; ")})`
        : null,
  };
}
