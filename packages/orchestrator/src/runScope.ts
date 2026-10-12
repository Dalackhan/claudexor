/**
 * Per-run process custody: mint one scope marker before the first launch,
 * carry it (plus the host facts a scoped HOME owes the child) in every harness
 * `spec.env` the run builds, and end the marker's members at the whole-run
 * terminal barrier on every terminal — the engine side of "a finished
 * delegated run ends every OS process it left" (owner 1A).
 *
 * The durable discovery index lives in the daemon data root and is injected as
 * a {@link RunScopeCustodian} (the daemon wires {@link DaemonRunScopeIndex};
 * tests inject a temp one). An embedder without one still gets in-process
 * custody — a minted marker, carried and reaped at the barrier — but no
 * crash-recovery index, which is disclosed here rather than silently absent.
 */
import { join } from "node:path";
import {
  harnessHostFactsEnv,
  mintRunScopeMarker,
  reapScopeMembers,
  scopeMarkerEnv,
  type ScopeReapOutcome,
} from "@claudexor/core";
import {
  RunProcessScopeOutcome,
  type RunProcessScopeOutcome as RunProcessScopeOutcomeType,
} from "@claudexor/schema";
import type { AnnouncedRunContext } from "./runTerminalContext.js";
import type { ResolvedRouteContext } from "./routeContext.js";

export interface RunScopeCustodian {
  /**
   * Mint and durably record the run's scope marker BEFORE its first launch.
   * Returns the marker NAME to carry in every spec env. Must not throw for a
   * recoverable persistence failure — it degrades to in-process custody and
   * discloses, never fails the run.
   */
  open(runId: string): Promise<{ marker: string }>;
  /**
   * End every live process carrying the run's marker and retire/disclose the
   * durable entry. Idempotent per run.
   */
  settle(runId: string, marker: string): Promise<ScopeReapOutcome>;
}

/**
 * The default custodian for an embedder/test with no daemon index: it mints
 * and reaps in process (no durable crash-recovery record). The reaper's own
 * per-marker coalescing makes repeat settles safe.
 */
export const inProcessRunScopeCustodian: RunScopeCustodian = {
  async open() {
    return { marker: mintRunScopeMarker() };
  },
  async settle(_runId, marker) {
    return reapScopeMembers({ marker });
  },
};

/**
 * Add the run's scope marker (and, when the env is a scoped native-state HOME,
 * the host facts) to a harness spec env WITHOUT overwriting the existing
 * HOME/config/auth patch. The marker is applied last so it always survives.
 * `baseEnv` may be absent (an in-place run that inherits the operator env):
 * the marker still applies so the run can end what it leaves. Returns
 * `undefined` only when there is no marker (custody disabled).
 */
export function scopedSpecEnv(
  marker: string | undefined,
  baseEnv: Record<string, string> | undefined,
  options: { source?: NodeJS.ProcessEnv } = {},
): Record<string, string> | undefined {
  if (!marker) return baseEnv;
  return {
    ...(baseEnv ?? {}),
    ...harnessHostFactsEnv(baseEnv, options),
    ...scopeMarkerEnv(marker),
  };
}

function toFacts(marker: string, outcome: ScopeReapOutcome): RunProcessScopeOutcomeType {
  return RunProcessScopeOutcome.parse({
    marker,
    coverage: outcome.coverage,
    census: outcome.census,
    census_failure: outcome.censusFailure,
    restricted: outcome.restricted,
    ended: outcome.ended.map((m) => ({ pid: m.pid, start_token: m.startToken })),
    survivors: outcome.survivors.map((m) => ({ pid: m.pid, start_token: m.startToken })),
    unreadable: outcome.unreadable.map((u) => ({ pid: u.pid, reason: u.reason })),
    reused_groups: outcome.reusedGroups,
    settled: outcome.settled,
    completeness: outcome.completeness,
    completeness_reason: outcome.completenessReason,
    incomplete: outcome.incomplete,
  });
}

/** The outcome written when the custodian itself failed: unknown, never clean. */
export function failedScopeOutcome(reason: string): ScopeReapOutcome {
  return {
    coverage: "marker",
    census: "failed",
    censusFailure: reason,
    ended: [],
    survivors: [],
    unreadable: [],
    reusedGroups: [],
    settled: false,
    incomplete: false,
    completeness: "not_provable",
    completenessReason: reason,
    restricted: process.platform === "darwin",
    durationMs: 0,
  };
}

/**
 * Write the scope outcome to its OWN terminal artifact (`final/process_scope.yaml`)
 * so it survives the record rewrites and projections the immutable RunFacts
 * receipt goes through. Best-effort: a write failure never fails an
 * already-terminal run (the reap itself already happened).
 */
export function writeRunScopeFacts(
  ctx: AnnouncedRunContext,
  marker: string,
  outcome: ScopeReapOutcome,
): RunProcessScopeOutcomeType | null {
  try {
    const facts = toFacts(marker, outcome);
    ctx.store.writeYaml(join(ctx.paths.finalDir, "process_scope.yaml"), facts);
    return facts;
  } catch {
    return null;
  }
}

/**
 * The route-admitting readiness probe and the run must share the EXACT env
 * (W3.3 / TZ-1 §B: evidence gathered in one env while the run executes in
 * another is not evidence). The marker and host facts therefore join the
 * route context itself, so the probe, the model inventory and the spawn all
 * see one env; `scopedSpecEnv` on the eventual spec is then idempotent.
 */
export function scopedRouteContext(
  ctx: ResolvedRouteContext,
  marker: string | undefined,
): ResolvedRouteContext {
  if (!marker) return ctx;
  const envForHarness = ctx.envForHarness;
  return {
    ...ctx,
    env: scopedSpecEnv(marker, ctx.env) ?? ctx.env,
    ...(envForHarness
      ? {
          envForHarness: (harnessId: string) => {
            const lane = envForHarness(harnessId);
            return lane ? (scopedSpecEnv(marker, lane) ?? lane) : null;
          },
        }
      : {}),
  };
}
