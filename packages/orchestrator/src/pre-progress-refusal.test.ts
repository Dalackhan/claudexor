import { describe, expect, it } from "vitest";
import type {
  CredentialProfile,
  HarnessEvent,
  PreProgressRefusalObservation,
} from "@claudexor/schema";
import type { AttemptOutputMarkers } from "./attemptOutputMarkers.js";
import {
  preProgressRefusalSubject,
  refusedBeforeProgress,
  type PreProgressRefusalMemory,
  type ServiceProducer,
} from "./pre-progress-refusal.js";
import type { RotationEvidence } from "./rotation-predicate.js";

const structural: RotationEvidence = {
  sawTypedLimit: false,
  deliverableEmpty: true,
  mutationObserved: false,
  terminalNonTransientDeath: true,
  sawAgentProgress: false,
};
const started: AttemptOutputMarkers = {
  sawAgentProgress: false,
  fileChanges: 0,
  sawSessionStart: true,
};

describe("refusedBeforeProgress (#363: outcome, never wording)", () => {
  it("marks a started session that died terminally before any progress", () => {
    expect(refusedBeforeProgress(structural, started)).toBe(true);
  });

  it.each<[string, Partial<RotationEvidence>, Partial<AttemptOutputMarkers>]>([
    // An adapter's own pre-spawn refusal (a probe that could not confirm the
    // login) never reached the vendor: it is not the account refusing.
    ["no typed session start", {}, { sawSessionStart: false }],
    ["absent session-start evidence", {}, { sawSessionStart: undefined }],
    // A typed limit is the quota registry's cooldown, not this memory's.
    ["a typed vendor limit", { sawTypedLimit: true }, {}],
    ["agent progress", { sawAgentProgress: true }, { sawAgentProgress: true }],
    ["an observed mutation", { mutationObserved: true }, { fileChanges: 1 }],
    ["a deliverable", { deliverableEmpty: false }, {}],
    // Transient-retryable deaths stay with same-profile retries.
    ["a transient-retryable death", { terminalNonTransientDeath: false }, {}],
  ])("stays quiet for %s", (_label, evidence, markers) => {
    expect(refusedBeforeProgress({ ...structural, ...evidence }, { ...started, ...markers })).toBe(
      false,
    );
  });
});

function row(overrides: Partial<CredentialProfile> = {}): CredentialProfile {
  return {
    profile_id: "a",
    harness_id: "cursor",
    display_name: "a",
    credential_kind: "config_dir_login",
    isolation_locator: "/tmp/claudexor-test/profiles/cursor-a",
    secret_ref: null,
    enabled: true,
    created_at: null,
    ...overrides,
  };
}

function memory() {
  const recorded: Array<Omit<PreProgressRefusalObservation, "observed_at" | "expires_at">> = [];
  const cleared: Array<[string, string, string | null]> = [];
  const generations = new Map<string, number>();
  const store: PreProgressRefusalMemory = {
    live: () => [],
    generation: (harnessId, profileId) => generations.get(`${harnessId}/${profileId}`) ?? 0,
    record: (value) => void recorded.push(value),
    clear: (harnessId, profileId, model) => void cleared.push([harnessId, profileId, model]),
  };
  /** A credential mutation of one account (what `clearSubject` does). */
  const mutate = (harnessId: string, profileId: string) =>
    generations.set(`${harnessId}/${profileId}`, store.generation(harnessId, profileId) + 1);
  return { store, recorded, cleared, mutate };
}

describe("preProgressRefusalSubject", () => {
  it("records (harness, account, requested model) and clears it only on a served try", () => {
    const m = memory();
    const subject = preProgressRefusalSubject(m.store, "cursor", {
      credential_profile: row(),
      model_hint: "grok-4.7",
    });
    subject?.note();
    expect(m.recorded).toEqual([
      { harness_id: "cursor", profile_id: "a", requested_model: "grok-4.7" },
    ]);
    // A try without progress that delivered nothing (errored, cancelled or
    // empty) served nothing: the mark stays.
    subject?.noteServed({ ...started }, false);
    expect(m.cleared).toEqual([]);
    // Progress (even on a later-failing try) or a delivered result proves service.
    subject?.noteServed({ ...started, sawAgentProgress: true }, false);
    subject?.noteServed({ ...started }, true);
    expect(m.cleared).toEqual([
      ["cursor", "a", "grok-4.7"],
      ["cursor", "a", "grok-4.7"],
    ]);
  });

  it("binds the account's credential generation at try start: a late outcome never crosses a mutation", () => {
    const m = memory();
    const spec = { credential_profile: row(), model_hint: "grok-4.7" };
    const inFlight = preProgressRefusalSubject(m.store, "cursor", spec);
    const sibling = preProgressRefusalSubject(m.store, "cursor", {
      ...spec,
      credential_profile: row({ profile_id: "b" }),
    });
    // The account's credential changes while its try is still running.
    m.mutate("cursor", "a");
    // The old credential's refusal must not recreate the mark the mutation
    // voided, and its success must not delete a mark about the new credential.
    inFlight?.note();
    inFlight?.noteServed({ ...started, sawAgentProgress: true }, true);
    expect(m.recorded).toEqual([]);
    expect(m.cleared).toEqual([]);
    // Another account's in-flight try is not affected by that mutation.
    sibling?.note();
    expect(m.recorded).toEqual([
      { harness_id: "cursor", profile_id: "b", requested_model: "grok-4.7" },
    ]);
    // A try bound after the mutation speaks for the new credential.
    preProgressRefusalSubject(m.store, "cursor", spec)?.note();
    expect(m.recorded).toHaveLength(2);
  });

  it("reports whether the bound credential is still current: a mutation or an open login window ends it (#363)", () => {
    const m = memory();
    const spec = { credential_profile: row(), model_hint: "grok-4.7" };
    const bound = preProgressRefusalSubject(m.store, "cursor", spec);
    expect(bound?.current()).toBe(true);
    m.mutate("cursor", "b");
    expect(bound?.current()).toBe(true); // another account's change
    m.mutate("cursor", "a");
    expect(bound?.current()).toBe(false);
    // Inside a login window the ledger's generation is no number at all: a
    // try bound there is never current, nor is one bound before it.
    const beforeWindow = preProgressRefusalSubject(m.store, "cursor", spec);
    const windowStore: PreProgressRefusalMemory = { ...m.store, generation: () => Number.NaN };
    const inside = preProgressRefusalSubject(windowStore, "cursor", spec);
    expect(inside?.current()).toBe(false);
    m.store.generation = () => Number.NaN;
    expect(beforeWindow?.current()).toBe(false);
  });

  it("keys the harness default model as null", () => {
    const m = memory();
    preProgressRefusalSubject(m.store, "cursor", {
      credential_profile: row(),
      model_hint: null,
    })?.note();
    expect(m.recorded[0]?.requested_model).toBeNull();
  });

  it("has nothing to remember without a memory, an account, or for a metered key row", () => {
    const m = memory();
    expect(
      preProgressRefusalSubject(undefined, "cursor", {
        credential_profile: row(),
        model_hint: null,
      }),
    ).toBeNull();
    expect(
      preProgressRefusalSubject(m.store, "cursor", { credential_profile: null, model_hint: null }),
    ).toBeNull();
    expect(
      preProgressRefusalSubject(m.store, "cursor", {
        credential_profile: row({
          credential_kind: "api_key",
          isolation_locator: null,
          secret_ref: "cursor:a",
        }),
        model_hint: null,
      }),
    ).toBeNull();
  });
});

/** A memory with durable last-served facts that records what the try wrote. */
function servingMemory() {
  const m = memory();
  const served: Array<[string, string | null, ServiceProducer]> = [];
  const retracted: Array<[string, string | null, ServiceProducer]> = [];
  m.store.services = {
    serve: (profile, model, producer) => void served.push([profile.profile_id, model, producer]),
    retract: (profile, model, producer) =>
      void retracted.push([profile.profile_id, model, producer]),
    orders: () => new Map(),
  };
  return { ...m, served, retracted };
}
const producer: ServiceProducer = { runId: "run-1", attemptId: "att-1", tryIndex: 0 };
const event = (overrides: Partial<HarnessEvent>): HarnessEvent => ({
  type: "status",
  session_id: "s",
  ts: "2026-10-13T00:00:00.000Z",
  ...overrides,
});
const progressed: AttemptOutputMarkers = { ...started, sawAgentProgress: true };

describe("preProgressRefusalSubject: last-served facts (INV-135 tie-break)", () => {
  it("serves the request once per try, at the first typed agent progress", () => {
    const m = servingMemory();
    const subject = preProgressRefusalSubject(
      m.store,
      "cursor",
      { credential_profile: row(), model_hint: "grok-4.7" },
      producer,
    );
    subject?.observe(event({ type: "started" }), started);
    expect(m.served).toEqual([]);
    subject?.observe(event({ type: "thinking", text: "plan" }), progressed);
    subject?.observe(event({ type: "tool_call" }), progressed);
    subject?.noteServed(progressed, true);
    expect(m.served).toEqual([["a", "grok-4.7", producer]]);
  });

  it.each([
    ["a Claude alias answered under its resolved id", "claude", "fable", "claude-fable-5-1"],
    ["a Cursor picker answered under a display label", "cursor", "auto", "Auto"],
  ])("never compares the observed model label: %s still serves", (_l, harness, asked, seen) => {
    const m = servingMemory();
    const subject = preProgressRefusalSubject(
      m.store,
      harness,
      { credential_profile: row({ harness_id: harness }), model_hint: asked },
      producer,
    );
    subject?.observe(event({ type: "started", observed_model: seen }), started);
    subject?.observe(event({ type: "tool_call", observed_model: seen }), progressed);
    expect(m.served).toEqual([["a", asked, producer]]);
    expect(m.retracted).toEqual([]);
  });

  it("an error-free delivery with no typed progress serves; a try that delivered nothing does not", () => {
    const delivered = servingMemory();
    preProgressRefusalSubject(
      delivered.store,
      "cursor",
      { credential_profile: row(), model_hint: null },
      producer,
    )?.noteServed(started, true);
    expect(delivered.served).toEqual([["a", null, producer]]);
    // Message-only, errored, cancelled or empty: no progress and no delivery.
    const quiet = servingMemory();
    const subject = preProgressRefusalSubject(
      quiet.store,
      "cursor",
      { credential_profile: row(), model_hint: null },
      producer,
    );
    subject?.observe(event({ type: "message", text: "You're out of usage." }), started);
    subject?.observe(event({ type: "error", error: "refused" }), started);
    subject?.noteServed(started, false);
    expect(quiet.served).toEqual([]);
  });

  it.each([
    ["another account", { credential_profile_id: "b" }],
    ["a paid API-key route", { credential_route: "managed_api_key" as const }],
  ])("a try whose own events name %s is not this account's service", (_l, identity) => {
    const m = servingMemory();
    const subject = preProgressRefusalSubject(
      m.store,
      "cursor",
      { credential_profile: row(), model_hint: "m" },
      producer,
    );
    subject?.observe(event({ type: "started", ...identity }), started);
    subject?.observe(event({ type: "tool_call" }), progressed);
    subject?.noteServed(progressed, true);
    expect(m.served).toEqual([]);
    // Neither positive nor negative facts about the bound row move.
    expect(m.cleared).toEqual([]);
  });

  it("a late identity contradiction retracts only the fact this producer wrote", () => {
    const m = servingMemory();
    const subject = preProgressRefusalSubject(
      m.store,
      "cursor",
      { credential_profile: row(), model_hint: "m" },
      producer,
    );
    subject?.observe(event({ type: "tool_call", credential_profile_id: "a" }), progressed);
    expect(m.served).toEqual([["a", "m", producer]]);
    subject?.observe(event({ type: "status", credential_route: "managed_api_key" }), progressed);
    subject?.observe(event({ type: "status", credential_profile_id: "b" }), progressed);
    subject?.noteServed(progressed, true);
    expect(m.retracted).toEqual([["a", "m", producer]]);
    expect(m.served).toHaveLength(1);
  });

  it("a credential change between bind and progress, or a bind inside a login window, writes nothing", () => {
    const m = servingMemory();
    const spec = { credential_profile: row(), model_hint: "m" };
    const changed = preProgressRefusalSubject(m.store, "cursor", spec, producer);
    m.mutate("cursor", "a");
    changed?.observe(event({ type: "tool_call" }), progressed);
    changed?.noteServed(progressed, true);
    const windowStore: PreProgressRefusalMemory = { ...m.store, generation: () => Number.NaN };
    const inside = preProgressRefusalSubject(windowStore, "cursor", spec, producer);
    inside?.observe(event({ type: "tool_call" }), progressed);
    inside?.noteServed(progressed, true);
    expect(m.served).toEqual([]);
    // A try bound after the change speaks for the new credential.
    preProgressRefusalSubject(m.store, "cursor", spec, producer)?.noteServed(progressed, false);
    expect(m.served).toEqual([["a", "m", producer]]);
  });

  it("writes nothing durable without a producer, and a failing write never fails the try", () => {
    const m = servingMemory();
    const spec = { credential_profile: row(), model_hint: "m" };
    preProgressRefusalSubject(m.store, "cursor", spec)?.noteServed(progressed, true);
    expect(m.served).toEqual([]);
    m.store.services!.serve = () => {
      throw new Error("disk full");
    };
    const failing = preProgressRefusalSubject(m.store, "cursor", spec, producer);
    expect(() => failing?.observe(event({ type: "tool_call" }), progressed)).not.toThrow();
    expect(() => failing?.noteServed(progressed, true)).not.toThrow();
    // Both tries served: the negative mark clears on the same predicate either way.
    expect(m.cleared).toEqual([
      ["cursor", "a", "m"],
      ["cursor", "a", "m"],
    ]);
  });
});
