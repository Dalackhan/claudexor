import { uptime } from "node:os";
import { performance } from "node:perf_hooks";
import { credentialMutationWindowOpen } from "@claudexor/core";
import { probeCursorNativeAuth, type CursorStatusObservation } from "./auth.js";

type EnvMap = Record<string, string | null | undefined>;
type StatusProbe = (env?: EnvMap, abortSignal?: AbortSignal) => Promise<CursorStatusObservation>;
type Authenticated = Extract<CursorStatusObservation, { kind: "authenticated" }>;

/**
 * How long a POSITIVE status answer for one profile store is reused instead
 * of spawning another `cursor-agent status`. Short on purpose: long enough to
 * cover one run's admission → pool readiness → spawn → rotation readiness
 * chain and a burst of concurrent runs; shorter than the doctor cache's reuse
 * of an OK report. A reuse keeps the instant the vendor answered.
 */
export const CURSOR_STATUS_REUSE_MS = 60_000;

/**
 * How long a store's last POSITIVE answer may stand in, disclosed as stale,
 * when a later probe of that store did not answer within its budget (#363,
 * owner-approved INV-135 amendment). The same five-minute horizon as quota
 * freshness: long enough to outlast a burst of host load across several runs,
 * far shorter than a login session. Only a timeout consults it; any other
 * unknown answer, a logged-out answer or a credential mutation never does.
 */
export const CURSOR_STATUS_LAST_POSITIVE_MS = 5 * 60_000;

/** True only when the supplied env explicitly selects the vendor FILE store
 * (an account row's HOME, `AGENT_CLI_CREDENTIAL_STORE=file`). Any other env
 * would resolve the HOST Keychain login, which is never read (D-U3). */
export function cursorFileStoreEnv(env?: EnvMap): boolean {
  return env?.["AGENT_CLI_CREDENTIAL_STORE"] === "file";
}

/**
 * The auth store a profile-scoped status probe reads, or null when the env is
 * not one this coordinator may share: only the vendor FILE store with the API
 * key explicitly scrubbed (every row env from `cursorProfileRunEnv`). The
 * store is selected by HOME/USERPROFILE, XDG_CONFIG_HOME and APPDATA; the
 * lane's CURSOR_CONFIG_DIR relocates session state, not auth, so admission
 * (row HOME state) and spawn (lane HOME state) share one entry.
 */
function statusStoreKey(env?: EnvMap): string | null {
  if (!env || !cursorFileStoreEnv(env) || env["CURSOR_API_KEY"] !== null) return null;
  const home = env["HOME"];
  if (!home) return null;
  return JSON.stringify([home, env["USERPROFILE"], env["XDG_CONFIG_HOME"], env["APPDATA"]]);
}

function abortedProbe(): CursorStatusObservation {
  return { kind: "unknown", error: "cursor-agent status probe aborted" };
}

function supersededProbe(): CursorStatusObservation {
  return {
    kind: "unknown",
    error: "cursor-agent status answer predates a credential change; login state unknown",
  };
}

/** Wait for a shared probe without letting one caller's cancel kill it for all. */
async function awaitShared(
  shared: Promise<CursorStatusObservation>,
  signal?: AbortSignal,
): Promise<CursorStatusObservation> {
  if (!signal) return shared;
  if (signal.aborted) return abortedProbe();
  return new Promise((resolve) => {
    const onAbort = () => resolve(abortedProbe());
    signal.addEventListener("abort", onAbort, { once: true });
    void shared.then((result) => {
      signal.removeEventListener("abort", onAbort);
      resolve(signal.aborted ? abortedProbe() : result);
    });
  });
}

/**
 * ONE process-local coordinator for profile-scoped `cursor-agent status`
 * (#363). Run admission, pool readiness, the adapter's spawn-time route check
 * and rotation readiness ask the SAME row store within seconds, and concurrent
 * runs ask at once; on a loaded host every extra child raises the chance that
 * the probe's own budget kills one and a signed-in account reads as not ready.
 * So concurrent callers share one child per store, and a positive answer is
 * reused for `CURSOR_STATUS_REUSE_MS`. An unanswered probe is re-asked every
 * time — it never becomes a logout and never becomes a pass; while the store's
 * last positive answer is younger than `CURSOR_STATUS_LAST_POSITIVE_MS`, the
 * timed-out answer stays unknown but carries it as `lastPositive`. A logged-out
 * answer drops the store's positive entirely. `clear()` (credential mutations)
 * drops every positive and stops an in-flight probe from repopulating it; that
 * probe answers the callers already waiting on it unknown: its verdict may
 * describe the store before the change.
 *
 * Every age is MONOTONIC (`monotonicMs`): a wall-clock step can neither keep
 * an answer alive nor expire it early. The wall clock only stamps the instant
 * the vendor answered, for disclosure. While a login may be rewriting the
 * cursor store (`mutating`, the daemon's setup lifecycle), a probe answers its
 * callers live and nothing else: no reuse, no retained positive, no last
 * positive behind a timeout — neither for a probe started inside the window
 * nor for one that ends inside it.
 */
export function createCursorStatusCoordinator(options: {
  probe: StatusProbe;
  monotonicMs?: () => number;
  wallMs?: () => number;
  mutating?: () => boolean;
  reuseMs?: number;
  lastPositiveMs?: number;
}): { status: StatusProbe; clear(): void } {
  // Linux performance.now() excludes suspend. libuv's uptime uses /proc/uptime
  // or CLOCK_BOOTTIME, both suspend-inclusive; its fallback truncates seconds.
  // Use an upper age bound there (less than two seconds early expiry), never
  // extend freshness through sleep or let a wall-clock change decide it.
  const linuxUptime = !options.monotonicMs && process.platform === "linux";
  const monotonicMs =
    options.monotonicMs ?? (linuxUptime ? () => uptime() * 1000 : () => performance.now());
  const clockUncertaintyMs = linuxUptime ? 1000 : 0;
  const wallMs = options.wallMs ?? Date.now;
  const mutating = options.mutating ?? (() => credentialMutationWindowOpen("cursor"));
  const reuseMs = options.reuseMs ?? CURSOR_STATUS_REUSE_MS;
  const lastPositiveMs = options.lastPositiveMs ?? CURSOR_STATUS_LAST_POSITIVE_MS;
  // One entry per store: its latest positive answer, reused as fresh inside
  // `reuseMs` and offered as stale evidence to a timeout inside `lastPositiveMs`.
  const positives = new Map<
    string,
    { observation: Authenticated; atMonotonicMs: number; observedAt: string }
  >();
  const pending = new Map<string, Promise<CursorStatusObservation>>();
  let generation = 0;
  const livePositive = (key: string, withinMs: number) => {
    const entry = positives.get(key);
    if (!entry) return null;
    const ageMs = Math.ceil(Math.max(0, monotonicMs() - entry.atMonotonicMs + clockUncertaintyMs));
    if (ageMs < withinMs) return { entry, ageMs };
    if (ageMs >= lastPositiveMs) positives.delete(key);
    return null;
  };
  return {
    async status(env, abortSignal) {
      const key = statusStoreKey(env);
      if (key === null) return options.probe(env, abortSignal);
      if (abortSignal?.aborted) return abortedProbe();
      const fenced = mutating();
      const fresh = fenced ? null : livePositive(key, reuseMs);
      if (fresh) return fresh.entry.observation;
      let shared = pending.get(key);
      if (!shared) {
        const startedGeneration = generation;
        const probe = options
          .probe(env)
          .catch((err: unknown): CursorStatusObservation => ({
            kind: "unknown",
            error: err instanceof Error ? err.message : String(err),
          }))
          .then((observation): CursorStatusObservation => {
            if (startedGeneration !== generation) return supersededProbe();
            // An answer read inside a mutation window is the vendor's live
            // answer for its callers only; it seeds and consumes nothing.
            const settled = !fenced && !mutating();
            if (observation.kind === "loggedOut") {
              positives.delete(key);
              return observation;
            }
            if (observation.kind === "unknown") {
              // Only a probe that did not answer may lean on the last positive
              // answer; it stays unknown and never refreshes that answer's age.
              const stale =
                settled && observation.timedOut ? livePositive(key, lastPositiveMs) : null;
              return stale
                ? {
                    ...observation,
                    lastPositive: { observedAt: stale.entry.observedAt, ageMs: stale.ageMs },
                  }
                : observation;
            }
            const observedAt = new Date(wallMs()).toISOString();
            const stamped = { ...observation, observedAt };
            if (settled) {
              positives.set(key, {
                observation: stamped,
                atMonotonicMs: monotonicMs(),
                observedAt,
              });
            }
            return stamped;
          })
          .finally(() => {
            if (pending.get(key) === probe) pending.delete(key);
          });
        shared = probe;
        pending.set(key, shared);
      }
      return awaitShared(shared, abortSignal);
    },
    clear() {
      generation += 1;
      positives.clear();
      pending.clear();
    },
  };
}

const processCoordinator = createCursorStatusCoordinator({
  probe: (env, abortSignal) => probeCursorNativeAuth(env, abortSignal),
});

/** The adapter's default native status probe: coordinated per profile store. */
export const coordinatedCursorNativeAuth: StatusProbe = (env, abortSignal) =>
  processCoordinator.status(env, abortSignal);

/** Drop every reused answer (credential mutation / login / logout). */
export function clearCursorStatusCache(): void {
  processCoordinator.clear();
}
