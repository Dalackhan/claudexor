/**
 * Cross-run memory of a pool account's PRE-PROGRESS REFUSAL (#363), and its
 * positive twin: the LAST-SERVED fact (INV-135 tie-break).
 *
 * The structural rotation branch (`structural_pre_progress_failure`) already
 * moves one run off an account whose vendor refused it before any work, without
 * reading the vendor's wording. This module carries that same typed outcome to
 * LATER unpinned runs: the account is ranked after its selectable siblings for
 * the same requested model until the observation expires, the account serves
 * that model again, or its credential changes. It never excludes a row, never
 * touches an explicit pin, and never claims spent quota (the cooldown
 * projection owns typed limits) or a dead credential (the A7 unusable ledger).
 *
 * Only a session the adapter reported as STARTED counts: an adapter's own
 * pre-spawn refusal — a readiness probe that could not confirm the login, a
 * misconfigured route — is not the vendor refusing the account.
 *
 * The same served predicate (typed agent progress, or an error-free delivery)
 * that clears a mark records that the account served this REQUEST under its
 * requested-model key. The vendor's model label is never compared with the
 * request: aliases and picker selectors are answered under resolved names, and
 * a served request proves the account works, not which model answered it.
 */
import type {
  CredentialProfile,
  HarnessEvent,
  HarnessRunSpec,
  PreProgressRefusalObservation,
} from "@claudexor/schema";
import type { AttemptOutputMarkers } from "./attemptOutputMarkers.js";
import {
  reactiveRotationEvidence,
  rotationRetryEligible,
  type RotationEvidence,
} from "./rotation-predicate.js";

/** The try that served: dedupe and producer-bound retraction key. */
export interface ServiceProducer {
  runId: string;
  attemptId: string;
  tryIndex: number;
}

/** The orchestrator's view of the daemon's durable last-served facts. */
export interface AccountServiceMemory {
  serve(profile: CredentialProfile, model: string | null, producer: ServiceProducer): void;
  retract(profile: CredentialProfile, model: string | null, producer: ServiceProducer): void;
  /** Service order per row for ONE ranking (higher = served more recently). */
  orders(
    harnessId: string,
    model: string | null,
    profiles: readonly CredentialProfile[],
  ): ReadonlyMap<string, number>;
}

/** The orchestrator's view of the daemon-owned bounded ledger. */
export interface PreProgressRefusalMemory {
  live(): readonly PreProgressRefusalObservation[];
  /** Moves when a credential change voids the account's verdicts. */
  generation(harnessId: string, profileId: string): number;
  record(value: Omit<PreProgressRefusalObservation, "observed_at" | "expires_at">): void;
  clear(harnessId: string, profileId: string, requestedModel: string | null): void;
  /** Durable last-served facts; absent = nothing durable (library embedders). */
  services?: AccountServiceMemory | null;
}

/** One try's outcome sink, bound before its session spawns. */
export interface PreProgressRefusalSubject {
  /** One stream event of the try: typed agent progress serves the request; an
   * event naming another account or a non-subscription route retracts. */
  observe(event: HarnessEvent, markers: AttemptOutputMarkers): void;
  note(): void;
  noteServed(markers: AttemptOutputMarkers, delivered: boolean): void;
  /** The account's credential is still the generation this try bound: no
   * credential change since, and no login window open now. */
  current(): boolean;
}

/**
 * The try's vendor session started and then ended in the structural branch's
 * own evidence: a terminal non-transient death with no agent progress, no
 * deliverable and no mutation. A TYPED limit is excluded on purpose — the quota
 * registry already records it as a cooldown the pool ranks as exhausted.
 */
export function refusedBeforeProgress(
  evidence: RotationEvidence,
  markers: AttemptOutputMarkers,
): boolean {
  return (
    !evidence.sawTypedLimit && markers.sawSessionStart === true && rotationRetryEligible(evidence)
  );
}

/**
 * Note THIS row's started-then-refused try, read from the try's own settled
 * facts; a pin or a profile-less default never records one. The rotation step
 * notes it, and so does a run stopped after the try settled, which then
 * probes, rotates and retries nothing.
 */
export function noteRefusedBeforeProgress(
  args: Parameters<typeof reactiveRotationEvidence>[0] & {
    spec: Pick<HarnessRunSpec, "credential_profile">;
    pinned?: boolean;
    notePreProgressRefusal?: () => void;
  },
): void {
  if (args.pinned || !args.spec.credential_profile) return;
  if (refusedBeforeProgress(reactiveRotationEvidence(args), args.markers))
    args.notePreProgressRefusal?.();
}

/**
 * Bind one try's subject — (harness, subscription account, requested model) —
 * to the memory, BEFORE the try's session spawns. Null when there is nothing
 * to remember: no memory configured, a profile-less default subject, or a
 * metered api_key row (never a pool row).
 *
 * The binding also holds the account's credential generation: a profile
 * mutation or login/logout does not wait for runs in flight, so an outcome
 * arriving after one is about a credential that change already voided. It
 * neither recreates the mark or service fact the change cleared nor clears a
 * mark a later try recorded about the changed credential. The store write
 * follows the generation check synchronously, so no clear can land between.
 */
export function preProgressRefusalSubject(
  memory: PreProgressRefusalMemory | undefined,
  harnessId: string,
  spec: Pick<HarnessRunSpec, "credential_profile" | "model_hint">,
  producer?: ServiceProducer,
): PreProgressRefusalSubject | null {
  const profile = spec.credential_profile ?? null;
  if (!memory || !profile || profile.credential_kind === "api_key") return null;
  const requestedModel = spec.model_hint ?? null;
  const generation = memory.generation(harnessId, profile.profile_id);
  const unchanged = () => memory.generation(harnessId, profile.profile_id) === generation;
  const services = producer ? (memory.services ?? null) : null;
  let served = false;
  let foreign = false;
  // Ordering evidence must never fail the try that produced it.
  const write = (action: (store: AccountServiceMemory) => void) => {
    try {
      if (services) action(services);
    } catch {
      /* the daemon logs its own write failures */
    }
  };
  const serve = () => {
    if (served || foreign || !services || !unchanged()) return;
    served = true;
    write((store) => store.serve(profile, requestedModel, producer!));
  };
  return {
    observe: (event, markers) => {
      if (
        (event.credential_profile_id !== undefined &&
          event.credential_profile_id !== profile.profile_id) ||
        (event.credential_route !== undefined && event.credential_route !== "vendor_native")
      ) {
        // The try itself says it is not this account's subscription session.
        if (served && !foreign) write((store) => store.retract(profile, requestedModel, producer!));
        foreign = true;
      } else if (markers.sawAgentProgress) serve();
    },
    note: () => {
      if (!unchanged()) return;
      memory.record({
        harness_id: harnessId,
        profile_id: profile.profile_id,
        requested_model: requestedModel,
      });
    },
    // Agent progress, or an error-free try that delivered, proves the account
    // served this request; a cancelled or empty try proves nothing.
    noteServed: (markers, delivered) => {
      if (foreign || !unchanged() || !(markers.sawAgentProgress || delivered)) return;
      memory.clear(harnessId, profile.profile_id, requestedModel);
      serve();
    },
    current: unchanged,
  };
}

/**
 * The latest live mark per account for this harness and requested model — the
 * instant the pool orders a demoted row by (oldest mark first).
 */
export function liveRefusalMarks(
  refusals: readonly PreProgressRefusalObservation[],
  harnessId: string,
  model: string | null | undefined,
  now: number,
): Map<string, number> {
  const marks = new Map<string, number>();
  for (const obs of refusals) {
    if (obs.harness_id !== harnessId || obs.requested_model !== (model ?? null)) continue;
    const observed = Date.parse(obs.observed_at);
    const expires = Date.parse(obs.expires_at);
    if (!Number.isFinite(observed) || !Number.isFinite(expires) || expires <= now) continue;
    marks.set(obs.profile_id, Math.max(observed, marks.get(obs.profile_id) ?? observed));
  }
  return marks;
}
