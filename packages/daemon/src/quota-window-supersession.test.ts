import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DurableJournal } from "@claudexor/journal";
import {
  quotaSnapshotIdentity,
  type QuotaSnapshot,
  type QuotaConstraint,
  type RateLimitSignal,
} from "@claudexor/schema";
import { BudgetLedger } from "../../budget/src/ledger.js";
import { selectFromAccountPool } from "../../orchestrator/src/account-pool.js";
import { profileQuotaBlock } from "../../orchestrator/src/credential-cooldown.js";
import { claudeRateLimitEvents } from "../../harness-claude/src/context-signals.js";
import {
  codexRateLimitEvents,
  parseCodexRateLimitsResponse,
} from "../../harness-codex/src/quota.js";
import { parseCodexStderrFailure } from "../../harness-codex/src/parse.js";
import { QuotaRegistry } from "./quota-registry.js";
import type { QuotaVendorRefresher } from "./quota-poll-lanes.js";
import { journalFoldPolicy } from "./journal-fold-policy.js";

const START = Date.parse("2026-10-04T10:00:00Z");
const RESET = START + 7 * 24 * 3_600_000;
const iso = (offset: number) => new Date(START + offset).toISOString();
const subject = {
  harness: "claude",
  credential_route: "vendor_native" as const,
  subject_id: "work",
  plan_label: null,
};
const constraint = (extra: Partial<QuotaConstraint> = {}): QuotaConstraint => ({
  id: "five_hour",
  label: "5 hour",
  used_ratio: 0.2,
  window_seconds: 18000,
  resets_at: new Date(RESET).toISOString(),
  cooldown_until: null,
  ...extra,
});
const full = (time: number, constraints: QuotaConstraint[] = [constraint()]): QuotaSnapshot => ({
  subject,
  source: "claude_oauth_usage",
  observed_at: iso(time),
  freshness: "fresh",
  constraints,
});
const partial = (time: number, extra: Partial<QuotaConstraint> = {}): QuotaSnapshot => ({
  ...full(time),
  source: "claude_rate_limit_event",
  constraints: [constraint({ used_ratio: 1, ...extra })],
});

async function fixture(
  body: (f: {
    registry: () => QuotaRegistry;
    journal: () => DurableJournal;
    now: (offset: number) => void;
    restart: () => Promise<void>;
    replay: () => void;
    blocked: (model?: string, route?: "vendor_native" | "managed_api_key") => boolean;
  }) => Promise<void>,
  refreshers: QuotaVendorRefresher[] = [],
): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-window-supersession-")));
  mkdirSync(join(root, "compaction"), { mode: 0o700 });
  let now = START;
  const open = () =>
    new DurableJournal({
      rootDir: root,
      partition: "global",
      fold: journalFoldPolicy,
      compactionThresholdBytes: 0,
      deferCompaction: true,
    });
  let journal = open();
  let registry = new QuotaRegistry(journal, refreshers, () => new Date(now));
  try {
    await body({
      registry: () => registry,
      journal: () => journal,
      now: (offset) => {
        now = START + offset;
      },
      restart: async () => {
        expect(
          await journal.compactInBackground({ stagingDir: join(root, "compaction") }),
        ).toHaveProperty("retainedCount");
        journal.close();
        journal = open();
        registry = new QuotaRegistry(journal, refreshers, () => new Date(now));
      },
      replay: () => {
        journal.close();
        journal = open();
        registry = new QuotaRegistry(journal, refreshers, () => new Date(now));
      },
      blocked: (model = "opus", route = "vendor_native") => {
        const snapshots = registry.read().snapshots;
        const result =
          profileQuotaBlock(
            snapshots,
            "claude",
            "work",
            route === "vendor_native" ? "local_session" : "api_key",
            model,
            new Date(now),
          ) !== null;
        const budget = new BudgetLedger();
        for (const snapshot of snapshots) budget.observeQuotaSnapshot(snapshot);
        expect(budget.cooldownActive("claude", route, "work", now, model)).toBe(result);
        return result;
      },
    });
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("full reads supersede matching native windows durably", () => {
  it("a real native measured rejection heals on early reset and remains healed after empty inventory, fold and late redelivery", async () =>
    fixture(async (f) => {
      f.registry().upsert(full(0));
      f.now(1000);
      const events = claudeRateLimitEvents(
        {
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "five_hour",
            utilization: 1,
            resetsAt: RESET / 1000,
          },
        },
        "session",
        iso(1000),
      );
      expect(events).toHaveLength(2);
      for (const event of events)
        f.registry().ingest("claude", {
          ...event,
          credential_route: "vendor_native",
          credential_profile_id: "work",
        });
      expect(f.blocked()).toBe(true);
      f.now(2000);
      f.registry().upsert(full(2000));
      expect(f.blocked()).toBe(false);
      f.now(3000);
      f.registry().upsert(full(3000, []));
      expect(f.blocked()).toBe(false);
      await f.restart();
      f.registry().upsert(partial(1000));
      expect(f.blocked()).toBe(false);
      f.now(26 * 3_600_000);
      f.registry().upsert(partial(1000));
      expect(f.blocked()).toBe(false);
    }));

  it("keeps newer and equal-time partial evidence, then accepts a truly newer recovery and a subsequent new rejection", async () =>
    fixture(async (f) => {
      f.registry().upsert(full(0));
      f.now(2000);
      f.registry().upsert(partial(2000));
      f.now(3000);
      f.registry().upsert(full(1000));
      expect(f.blocked()).toBe(true);
      f.registry().upsert(full(2000));
      expect(f.blocked()).toBe(true);
      f.registry().upsert(full(3000));
      expect(f.blocked()).toBe(false);
      f.registry().upsert(partial(3000));
      expect(f.blocked()).toBe(true); // equal timestamps have no proven ordering
      f.now(4000);
      f.registry().upsert(partial(4000, { resets_at: new Date(RESET + 60_000).toISOString() }));
      await f.restart();
      expect(f.blocked()).toBe(true);
      f.registry().upsert(partial(1000));
      expect(
        f
          .registry()
          .read()
          .snapshots.find((s) => s.source === "claude_rate_limit_event")?.observed_at,
      ).toBe(iso(4000));
    }));

  it("retires only the same window, duration, scope, account and credential route", async () =>
    fixture(async (f) => {
      f.registry().upsert(partial(0));
      const others: QuotaSnapshot[] = [
        partial(0, { id: "seven_day", window_seconds: 604800 }),
        partial(0, { applies_to_models: ["fable"] }),
        partial(0, { window_seconds: 60 }),
        { ...partial(0), subject: { ...subject, credential_route: "managed_api_key" } },
        { ...partial(0), subject: { ...subject, subject_id: "other" } },
      ];
      for (const other of others) f.registry().upsert(other);
      f.now(1000);
      f.registry().upsert(full(1000));
      const remaining = f
        .registry()
        .read()
        .snapshots.filter((s) => s.source === "claude_rate_limit_event");
      expect(remaining).toEqual(others);
      await f.restart();
      expect(
        f
          .registry()
          .read()
          .snapshots.filter((s) => s.source === "claude_rate_limit_event"),
      ).toHaveLength(5);
      expect(f.blocked()).toBe(true);
      expect(f.blocked("fable")).toBe(true);
      expect(f.blocked("opus", "managed_api_key")).toBe(true);
    }));

  it("absence, unknown usage, malformed and stale full reads cannot retire a known measured window", async () =>
    fixture(async (f) => {
      f.registry().upsert(partial(0));
      f.now(1000);
      f.registry().upsert(full(1000, []));
      expect(f.blocked()).toBe(true);
      f.registry().upsert(full(1000, [constraint({ used_ratio: null })]));
      expect(f.blocked()).toBe(true);
      expect(() =>
        f.registry().upsert({ ...full(1000), constraints: null } as unknown as QuotaSnapshot),
      ).toThrow();
      f.registry().upsert({ ...full(1000), freshness: "stale" });
      expect(f.blocked()).toBe(true);
      f.now(2000);
      f.registry().upsert(full(2000));
      expect(f.blocked()).toBe(false);
    }));

  it("persists an inverse timestamp-only witness and its cutoff before later inventory replacement", async () =>
    fixture(async (f) => {
      f.registry().upsert(full(0));
      f.now(2000);
      f.registry().upsert(full(2000));
      f.registry().upsert(partial(1000));
      expect(f.blocked()).toBe(false);
      const history = f.journal().records();
      expect(history.filter((r) => r.type === "quota.window.observed")).toHaveLength(1);
      expect(history.filter((r) => r.type === "quota.window.superseded")).toHaveLength(1);
      expect(
        history.filter((r) => r.type === "quota.snapshot.upserted").at(-1)?.payload,
      ).toMatchObject({ observed_at: iso(2000) });
      f.now(3000);
      f.registry().upsert(full(3000, [constraint({ id: "seven_day", window_seconds: 604800 })]));
      await f.restart();
      f.registry().upsert(partial(1000));
      expect(f.blocked()).toBe(false);
    }));

  it("remove/recreate clears the window cutoff together with that subject's evidence", async () =>
    fixture(async (f) => {
      f.registry().upsert(partial(0));
      f.now(1000);
      f.registry().upsert(full(1000));
      expect(f.blocked()).toBe(false);
      f.registry().removeSubject("claude", "work");
      await f.restart();
      expect(
        f
          .journal()
          .records()
          .filter((r) => r.type === "quota.window.superseded"),
      ).toEqual([]);
      f.registry().upsert(partial(0));
      expect(f.blocked()).toBe(true);
    }));

  it("writes witness and supersession atomically before changing effective state", async () =>
    fixture(async (f) => {
      f.registry().upsert(full(0));
      f.now(1000);
      f.registry().upsert(partial(1000));
      const append = vi.spyOn(f.journal(), "appendBatch").mockImplementationOnce(() => {
        throw new Error("simulated append failure");
      });
      f.now(2000);
      expect(() => f.registry().upsert(full(2000))).toThrow("simulated append failure");
      expect(f.blocked()).toBe(true);
      expect(
        f
          .journal()
          .records()
          .some((r) => r.type === "quota.window.superseded"),
      ).toBe(false);
      append.mockRestore();
      f.registry().upsert(full(2000));
      expect(f.blocked()).toBe(false);
      const records = f.journal().records();
      const retired = records.find((r) => r.type === "quota.window.superseded")!;
      expect(records.find((r) => r.seq === retired.seq - 1)).toMatchObject({
        type: "quota.snapshot.upserted",
        payload: { observed_at: iso(2000) },
      });
      await f.restart();
      expect(f.blocked()).toBe(false);
    }));

  it("orders observations per window rather than dropping an older sibling window", async () =>
    fixture(async (f) => {
      f.now(2000);
      f.registry().upsert(partial(2000, { used_ratio: 0.2 }));
      f.registry().upsert(partial(1000, { id: "seven_day", window_seconds: 604800 }));
      f.registry().upsert(partial(1000));
      expect(f.registry().read().snapshots).toHaveLength(2);
      expect(
        f
          .registry()
          .read()
          .snapshots.find((s) => s.constraints[0]?.id === "five_hour")?.constraints[0]?.used_ratio,
      ).toBe(0.2);
      expect(f.blocked()).toBe(true);
      await f.restart();
      expect(f.blocked()).toBe(true);
    }));
  it("the first genuinely newer partial remains durable even when its measurement repeats the retired bytes", async () =>
    fixture(async (f) => {
      f.registry().upsert(partial(0));
      f.now(1000);
      f.registry().upsert(full(1000));
      expect(f.blocked()).toBe(false);
      f.now(2000);
      f.registry().upsert(full(2000, []));
      f.now(3000);
      f.registry().upsert(partial(3000));
      expect(f.blocked()).toBe(true);
      const observations = f
        .journal()
        .records()
        .filter((r) => r.type === "quota.window.observed");
      expect(observations).toHaveLength(2);
      expect(observations.at(-1)?.payload).toMatchObject({
        version: 1,
        snapshot: {
          source: "claude_rate_limit_event",
          observed_at: iso(3000),
          constraints: [constraint({ used_ratio: 1 })],
        },
      });
      await f.restart();
      expect(f.blocked()).toBe(true);
      expect(
        f
          .registry()
          .read()
          .snapshots.find((s) => s.source === "claude_rate_limit_event")?.observed_at,
      ).toBe(iso(3000));
    }));
  it.each([0, 300])(
    "matches the recorded Codex notification/full-read window identity (duration minutes=%i)",
    async (durationMins) =>
      fixture(async (f) => {
        // The capture proves the native envelope and codex bucket name. Its zero
        // numbers are sanitized; exhaustion/reset values below are synthetic.
        const recorded = readFileSync(
          new URL(
            "../../harness-codex/fixtures/app-server/recorded-steer-0.156.1.jsonl",
            import.meta.url,
          ),
          "utf8",
        )
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((frame) => frame.method === "account/rateLimits/updated");
        expect(recorded).toBeDefined();
        const params = structuredClone(recorded.params);
        params.rateLimits.primary = {
          usedPercent: 100,
          windowDurationMins: durationMins,
          resetsAt: RESET / 1000,
        };
        const events = codexRateLimitEvents(params, "codex-session");
        expect(events).toHaveLength(1);
        expect(events[0]?.quota?.constraints[0]).toMatchObject({
          id: "codex:primary",
          window_seconds: durationMins === 0 ? null : 18000,
        });
        const native = {
          ...events[0]!,
          ts: iso(0),
          credential_route: "vendor_native",
          credential_profile_id: "work",
        };
        f.registry().ingest("codex", native);
        const blocked = () => {
          const snapshots = f.registry().read().snapshots;
          const routing =
            profileQuotaBlock(
              snapshots,
              "codex",
              "work",
              "local_session",
              "gpt-6-astra",
              new Date(iso(2000)),
            ) !== null;
          const budget = new BudgetLedger();
          for (const snapshot of snapshots) budget.observeQuotaSnapshot(snapshot);
          expect(
            budget.cooldownActive("codex", "vendor_native", "work", START + 2000, "gpt-6-astra"),
          ).toBe(routing);
          return routing;
        };
        expect(blocked()).toBe(true);
        params.rateLimits.primary.usedPercent = 20;
        const [observed] = parseCodexRateLimitsResponse(params, new Date(iso(1000)), "work");
        expect(observed?.constraints[0]).toMatchObject({
          id: "codex:primary",
          window_seconds: durationMins === 0 ? null : 18000,
        });
        f.now(1000);
        f.registry().upsert(observed!);
        expect(blocked()).toBe(false);
        f.now(2000);
        f.registry().upsert(
          parseCodexRateLimitsResponse({ rateLimits: null }, new Date(iso(2000)), "work")[0]!,
        );
        await f.restart();
        f.registry().ingest("codex", native);
        expect(blocked()).toBe(false);
      }),
  );
});

it("retires image response cooldown only after a newer matching measured image window, including durable replay", async () =>
  fixture(async (f) => {
    const imageSubject = { ...subject, harness: "codex" };
    const image = {
      ...partial(0, {
        id: "image_gen:primary",
        window_seconds: null,
        used_ratio: null,
        applies_to_request_kinds: ["image"],
        cooldown_until: new Date(RESET).toISOString(),
      }),
      subject: imageSubject,
      source: "codex_image_response" as const,
    };
    f.registry().upsert(image);
    const blocked = (kind: "text" | "image") =>
      profileQuotaBlock(
        f.registry().read().snapshots,
        "codex",
        "work",
        "local_session",
        "gpt-image-2",
        new Date(START + 2000),
        kind,
      ) !== null;
    expect(blocked("image")).toBe(true);
    expect(blocked("text")).toBe(false);
    f.now(1000);
    f.registry().upsert({
      ...full(1000, [constraint({ applies_to_request_kinds: ["text"] })]),
      subject: imageSubject,
      source: "codex_app_server",
    });
    expect(blocked("image")).toBe(true);
    f.now(2000);
    f.registry().upsert({
      ...full(2000, [
        constraint({
          id: "image_gen:primary",
          window_seconds: 86400,
          applies_to_request_kinds: ["image"],
        }),
      ]),
      subject: imageSubject,
      source: "codex_app_server",
    });
    expect(blocked("image")).toBe(false);
    await f.restart();
    f.registry().upsert(image);
    expect(blocked("image")).toBe(false);
    expect(blocked("text")).toBe(false);
  }));

describe("pre-request-kind Codex evidence yields only to a newer measured scoped read", () => {
  type Fixture = Parameters<Parameters<typeof fixture>[0]>[0];
  const AT = START + 10_000;
  const codex = { ...subject, harness: "codex" };
  const work = { harness: "codex", profile_id: "work" };
  const bucket = (limitId: string, usedPercent: number | null, mins = 300, name = "primary") => ({
    limitId,
    [name]: { usedPercent, windowDurationMins: mins, resetsAt: RESET / 1000 },
  });
  const fullRead = (time: number, buckets: object[], subjectId = "work") =>
    parseCodexRateLimitsResponse(
      {
        rateLimitsByLimitId: Object.fromEntries(buckets.map((b) => [Reflect.get(b, "limitId"), b])),
      },
      new Date(iso(time)),
      subjectId,
    )[0]!;
  const healthy = (time: number) =>
    fullRead(time, [bucket("codex", 20), bucket("image_gen", 10, 1440)]);
  /** The exact window upstream 8898a8e journaled from this notification:
   * today's Codex window without request-kind scope, i.e. universal. */
  const universal = (name = "primary", mins = 300): QuotaConstraint => {
    const [event] = codexRateLimitEvents({ rateLimits: bucket("codex", 100, mins, name) }, "s");
    const { applies_to_request_kinds: kinds, ...legacy } = event!.quota!.constraints[0]!;
    expect(kinds).toEqual(["text"]);
    return legacy;
  };
  const legacyWindow = (c: QuotaConstraint): QuotaSnapshot => ({
    subject: codex,
    source: "codex_app_server_event",
    observed_at: iso(0),
    freshness: "fresh",
    constraints: [c],
  });
  /** upstream 8898a8e rateLimitsFromLine shape: bare window id, no scope. */
  const rolloutWindow = (
    id: string,
    window_seconds: number | null,
    extra: Partial<QuotaConstraint> = {},
  ): QuotaConstraint => ({
    id,
    label: id,
    used_ratio: 1,
    window_seconds,
    resets_at: new Date(RESET).toISOString(),
    cooldown_until: null,
    ...extra,
  });
  const legacyRollout = (...constraints: QuotaConstraint[]): QuotaSnapshot => ({
    subject: codex,
    source: "codex_rollout",
    observed_at: iso(0),
    freshness: "fresh",
    constraints,
  });
  /** One legacy window in each retirement path's own pre-upgrade shape. */
  const legacyOn = {
    notification: (name: string, mins: number, extra: Partial<QuotaConstraint> = {}) =>
      legacyWindow({ ...universal(name, mins), ...extra }),
    rollout: (name: string, mins: number, extra: Partial<QuotaConstraint> = {}) =>
      legacyRollout(rolloutWindow(name, mins > 0 ? mins * 60 : null, extra)),
  };
  const rolloutIds = (f: Fixture) =>
    f
      .registry()
      .read()
      .snapshots.find((s) => s.source === "codex_rollout")
      ?.constraints.map((c) => c.id);
  /** Pre-upgrade journal record, replayed by a new registry. */
  function journaled(f: Fixture, snapshot: QuotaSnapshot) {
    if (snapshot.source === "codex_rollout")
      f.journal().append("quota.snapshot.upserted", snapshot);
    else f.journal().append("quota.window.observed", { version: 1, snapshot });
    f.replay();
  }
  /** The real admission readers must agree for both request kinds. */
  const blocked = (f: Fixture, model = "gpt-6-astra") =>
    Object.fromEntries(
      (["text", "image"] as const).map((kind) => {
        const snapshots = f.registry().read().snapshots;
        const block =
          profileQuotaBlock(
            snapshots,
            "codex",
            "work",
            "local_session",
            model,
            new Date(AT),
            kind,
          ) !== null;
        // The router ledger reads fresh evidence only; a reset-staled window
        // still blocks the cooldown and pool readers until its reset.
        if (kind === "text" && snapshots.every((s) => s.freshness === "fresh")) {
          const budget = new BudgetLedger();
          for (const snapshot of snapshots) budget.observeQuotaSnapshot(snapshot);
          expect(budget.cooldownActive("codex", "vendor_native", "work", AT, model)).toBe(block);
        }
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(AT);
        try {
          const selection = selectFromAccountPool({
            registry: [
              {
                profile_id: "work",
                harness_id: "codex",
                display_name: "work",
                credential_kind: "config_dir_login",
                isolation_locator: "/tmp/claudexor-test/profiles/codex-work",
                secret_ref: null,
                enabled: true,
                created_at: null,
              },
            ],
            harnessId: "codex",
            snapshots,
            readyProfileIds: new Set(["work"]),
            headroomThreshold: 0.9,
            model,
            requestKind: kind,
          });
          expect(selection.outcome === "exhausted").toBe(block);
        } finally {
          vi.useRealTimers();
        }
        return [kind, block];
      }),
    );
  const BOTH = { text: true, image: true };
  const NEITHER = { text: false, image: false };

  it("a newer authenticated text/image read retires a journaled universal notification window, durably", async () =>
    fixture(async (f) => {
      journaled(f, legacyWindow(universal()));
      expect(blocked(f)).toEqual(BOTH);
      f.now(1000);
      f.registry().upsert(healthy(1000));
      expect(blocked(f)).toEqual(NEITHER);
      await f.restart();
      expect(blocked(f)).toEqual(NEITHER);
      f.registry().upsert(legacyWindow(universal()));
      expect(blocked(f)).toEqual(NEITHER);
      // The cutoff names the journaled legacy identity; nothing is rewritten.
      expect(
        f
          .journal()
          .records()
          .filter((r) => r.type === "quota.window.superseded")
          .map((r) => r.payload),
      ).toEqual([
        {
          version: 1,
          subject: codex,
          snapshot_id: quotaSnapshotIdentity(legacyWindow(universal())),
          observed_at: iso(1000),
        },
      ]);
    }));

  it("an account reset alone keeps the future hard block; the following measured read clears it", async () => {
    let current!: Fixture;
    let duringRefresh: Record<string, boolean> | undefined;
    await fixture(
      async (f) => {
        current = f;
        journaled(f, legacyWindow(universal()));
        f.now(1000);
        await f.registry().refreshResources(work, true, true);
        expect(duringRefresh).toEqual(BOTH);
        expect(
          f
            .journal()
            .records()
            .some((r) => r.type === "quota.resources.invalidated"),
        ).toBe(true);
        expect(blocked(f)).toEqual(NEITHER);
        await f.restart();
        expect(blocked(f)).toEqual(NEITHER);
      },
      [
        {
          vendor: "codex",
          refresh: async () => {
            // The reset already marked the legacy window stale; a future
            // reset still blocks every admission reader.
            expect(current.registry().read().snapshots[0]?.freshness).toBe("stale");
            duringRefresh = blocked(current);
            return { snapshots: [healthy(1000)] };
          },
        },
      ],
    );
  });

  it("a journaled universal codex_rollout window retires only through its measured mapped window", async () =>
    fixture(async (f) => {
      journaled(
        f,
        legacyRollout(rolloutWindow("primary", 18000), rolloutWindow("secondary", 604800)),
      );
      expect(blocked(f)).toEqual(BOTH);
      f.now(1000);
      f.registry().upsert(healthy(1000));
      expect(rolloutIds(f)).toEqual(["secondary"]);
      expect(blocked(f)).toEqual(BOTH);
      f.now(2000);
      f.registry().upsert(
        fullRead(2000, [
          { ...bucket("codex", 20), ...bucket("codex", 30, 10080, "secondary") },
          bucket("image_gen", 10, 1440),
        ]),
      );
      expect(rolloutIds(f)).toEqual([]);
      expect(blocked(f)).toEqual(NEITHER);
      await f.restart();
      expect(blocked(f)).toEqual(NEITHER);
    }));

  const survivors: Array<
    [string, [string, number, Partial<QuotaConstraint>?], () => QuotaSnapshot]
  > = [
    ["no measured replacement", ["primary", 300], () => fullRead(1000, [])],
    ["unknown usage", ["primary", 300], () => fullRead(1000, [bucket("codex", null)])],
    [
      "an image-only measurement",
      ["primary", 300],
      () => fullRead(1000, [bucket("image_gen", 10)]),
    ],
    ["an older read", ["primary", 300], () => ({ ...healthy(1000), observed_at: iso(-1000) })],
    [
      "another profile's read",
      ["primary", 300],
      () => fullRead(1000, [bucket("codex", 20)], "other"),
    ],
    ["another window", ["secondary", 10080], () => healthy(1000)],
    ["another known duration", ["primary", 300], () => fullRead(1000, [bucket("codex", 20, 60)])],
    [
      "an unknown measured duration",
      ["primary", 300],
      () => fullRead(1000, [bucket("codex", 20, 0)]),
    ],
    [
      "a known duration for an unknown one",
      ["primary", 0],
      () => fullRead(1000, [bucket("codex", 20)]),
    ],
    [
      "another model scope",
      ["primary", 300, { applies_to_models: ["gpt-6-astra"] }],
      () => healthy(1000),
    ],
  ];
  it.each(
    (["notification", "rollout"] as const).flatMap((path) =>
      survivors.map(([name, legacy, read]) => [path, name, legacy, read] as const),
    ),
  )("a journaled universal %s window survives %s", async (path, _name, legacy, read) =>
    fixture(async (f) => {
      journaled(f, legacyOn[path](...legacy));
      f.now(1000);
      f.registry().upsert(read());
      expect(blocked(f)).toEqual(BOTH);
      await f.restart();
      expect(blocked(f)).toEqual(BOTH);
    }),
  );

  it.each(["notification", "rollout"] as const)(
    "an unknown legacy %s duration matches only an unknown measured duration, as window identity does",
    async (path) =>
      fixture(async (f) => {
        journaled(f, legacyOn[path]("primary", 0));
        expect(blocked(f)).toEqual(BOTH);
        f.now(1000);
        f.registry().upsert(fullRead(1000, [bucket("codex", 20, 0)]));
        expect(blocked(f)).toEqual(NEITHER);
        await f.restart();
        expect(blocked(f)).toEqual(NEITHER);
      }),
  );

  it("an explicit-kind rollout window is never released through the legacy branch", async () =>
    fixture(async (f) => {
      f.registry().upsert(
        legacyRollout(rolloutWindow("primary", 18000, { applies_to_request_kinds: ["image"] })),
      );
      f.now(1000);
      f.registry().upsert(healthy(1000));
      await f.restart();
      expect(blocked(f)).toEqual({ text: false, image: true });
    }));

  // Existing reactive policy, deliberately unchanged by the legacy branch.
  it("a same-kind rollout window keeps its existing rule: duration is not compared", async () =>
    fixture(async (f) => {
      f.registry().upsert(
        legacyRollout(rolloutWindow("primary", 18000, { applies_to_request_kinds: ["text"] })),
      );
      expect(blocked(f)).toEqual({ text: true, image: false });
      f.now(1000);
      f.registry().upsert(fullRead(1000, [bucket("codex", 20, 60)]));
      expect(rolloutIds(f)).toEqual([]);
      expect(blocked(f)).toEqual(NEITHER);
    }));

  it("a legacy generic cooldown keeps its existing retirement on any newer authenticated read", async () =>
    fixture(async (f) => {
      journaled(
        f,
        legacyRollout(
          rolloutWindow("cooldown", null, {
            label: "Cooldown",
            used_ratio: null,
            resets_at: null,
            cooldown_until: new Date(RESET).toISOString(),
          }),
          rolloutWindow("primary", 18000),
        ),
      );
      f.now(1000);
      f.registry().upsert(fullRead(1000, []));
      expect(rolloutIds(f)).toEqual(["primary"]);
      expect(blocked(f)).toEqual(BOTH);
    }));

  /** Today's real Codex refusal classifier scopes its generic cooldown to text. */
  const textRefusal = (signal: Partial<RateLimitSignal> = {}) => {
    const event = parseCodexStderrFailure("stream error: 429 Too Many Requests", "s", undefined)!;
    expect(event.rate_limit?.applies_to_request_kinds).toEqual(["text"]);
    return {
      ...event,
      ts: iso(0),
      credential_route: "vendor_native" as const,
      credential_profile_id: "work",
      rate_limit: { ...event.rate_limit!, ...signal },
    };
  };
  const TEXT = { text: true, image: false };

  it.each([
    ["an empty inventory", () => fullRead(1000, [])],
    ["an inventory of unrecognized buckets only", () => fullRead(1000, [bucket("review", 100)])],
    ["an image-only inventory", () => fullRead(1000, [bucket("image_gen", 10, 1440)])],
    ["unknown text usage", () => fullRead(1000, [bucket("codex", null)])],
    ["a measured text read", () => healthy(1000)],
  ])(
    "a text-scoped generic refusal yields to a newer authenticated read with %s",
    async (_, read) =>
      fixture(async (f) => {
        f.registry().ingest("codex", textRefusal());
        expect(blocked(f)).toEqual(TEXT);
        f.now(1000);
        f.registry().upsert(read());
        expect(blocked(f)).toEqual(NEITHER);
        await f.restart();
        expect(blocked(f)).toEqual(NEITHER);
      }),
  );

  it.each<[string, Partial<RateLimitSignal>, (f: Fixture) => void]>([
    [
      "an older read",
      {},
      (f: Fixture) => f.registry().upsert({ ...fullRead(1000, []), observed_at: iso(-1000) }),
    ],
    [
      "another profile's read",
      {},
      (f: Fixture) => f.registry().upsert(fullRead(1000, [], "other")),
    ],
    [
      "a stale read",
      {},
      (f: Fixture) => f.registry().upsert({ ...fullRead(1000, []), freshness: "stale" as const }),
    ],
    [
      "an unauthenticated measured notification",
      {},
      (f: Fixture) => {
        const [event] = codexRateLimitEvents({ rateLimits: bucket("codex", 20) }, "s");
        f.registry().ingest("codex", {
          ...event!,
          ts: iso(1000),
          credential_route: "vendor_native",
          credential_profile_id: "work",
        });
      },
    ],
    [
      "an empty read for a model-scoped refusal",
      { applies_to_models: ["gpt-6-astra"] },
      (f: Fixture) => f.registry().upsert(fullRead(1000, [])),
    ],
    [
      "an empty read for an identified window",
      { constraint_id: "codex:primary" },
      (f: Fixture) => f.registry().upsert(fullRead(1000, [])),
    ],
  ])("a text-scoped refusal survives %s", async (_, signal, read) =>
    fixture(async (f) => {
      f.registry().ingest("codex", textRefusal(signal));
      expect(blocked(f)).toEqual(TEXT);
      f.now(1000);
      read(f);
      expect(blocked(f)).toEqual(TEXT);
      await f.restart();
      expect(blocked(f)).toEqual(TEXT);
    }),
  );

  it.each([
    ["image", "text"],
    ["text", "image"],
  ] as const)(
    "an explicit %s window is never retired by a measured %s read of the same id",
    async (held, read) =>
      fixture(async (f) => {
        const same = (used_ratio: number, kind: "text" | "image") =>
          constraint({ id: "codex:primary", used_ratio, applies_to_request_kinds: [kind] });
        f.registry().upsert(legacyWindow(same(1, held)));
        f.now(1000);
        f.registry().upsert({ ...healthy(1000), constraints: [same(0.2, read)] });
        await f.restart();
        expect(blocked(f)).toEqual({ [held]: true, [read]: false });
      }),
  );
});
