import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CredentialProfile, SessionCapsule, RunResumable } from "@claudexor/schema";
import { createCodexAdapter } from "@claudexor/harness-codex";
import { ArtifactStore } from "@claudexor/artifact-store";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { createNativeHomeRetention } from "./native-home-retention.js";
import { createRetentionRunner } from "./retention-service.js";
import { buildRegistry } from "./registry.js";
let root: string;
let before: string | undefined;
let sql: Awaited<ReturnType<typeof sqlFixture>>;
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const old = new Date("2020-01-01");
let busy = false;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-native-retention-")));
  before = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
  mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
  sql = await sqlFixture(join(root, "sql"));
  busy = false;
});
afterEach(async () => {
  await sql?.close();
  if (before === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
  else process.env.CLAUDEXOR_CONFIG_DIR = before;
  rmSync(root, { recursive: true, force: true });
});
function profile() {
  return CredentialProfile.parse({
    profile_id: "disabled",
    display_name: "Disabled fixture",
    harness_id: "codex",
    credential_kind: "config_dir_login",
    isolation_locator: join(root, "engine", "profiles", "disabled"),
    enabled: false,
  });
}
function seed(n: number) {
  const file = join(
    profile().isolation_locator!,
    "sessions",
    "2020",
    "01",
    "01",
    `rollout-2020-01-01T00-00-00-${id(n)}.jsonl`,
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `rollout ${n}`);
  utimesSync(file, old, old);
  return file;
}
function capsule(n: number) {
  const path = join(
    new ArtifactStore(join(root, "unregistered")).runsDir(),
    `run-${n}`,
    "attempts",
    "a01",
    "session-capsule.json",
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      SessionCapsule.parse({
        harness: "codex",
        nativeSessionId: id(n),
        holderProfileId: "disabled",
        file: null,
        mtimeMs: null,
        cwd: root,
        requestedModel: null,
      }),
    ),
  );
  return path;
}
const request = (dryRun = false) => ({
  dryRun,
  olderThan: Date.now() - 30 * 86400000,
  ignoredRunIds: new Set<string>(),
  ignoredThreadIds: new Set<string>(),
});
function native(duringProfileScan?: () => void) {
  const adapter = createCodexAdapter();
  const lifetime = adapter.nativeHomeLifetime!;
  if (lifetime.status !== "managed") throw new Error("missing native owner");
  adapter.nativeHomeLifetime = {
    ...lifetime,
    prune: async (input) => {
      const pending = lifetime.prune(input);
      if (input.home === profile().isolation_locator && duringProfileScan) {
        await yieldToAdmission();
        duringProfileScan();
      }
      return pending;
    },
  };
  return createNativeHomeRetention({
    threads: sql.graph.threads,
    isBusy: () => busy,
    registry: () => new Map([["codex", adapter]]),
    profiles: () => [profile()],
  });
}
it("protects archived SQL sessions, retained run capsules and resumable pins, and prunes an idle disabled home", async () => {
  const repo = join(root, "repo");
  mkdirSync(repo);
  const project = sql.graph.projects.register({
    root: repo,
    clientId: "test",
    idempotencyKey: "p",
  }).project;
  const thread = sql.graph.threads.createThread({
    title: "session",
    repoRoot: repo,
    workspace: "in_place",
  });
  sql.graph.threads.recordSession(thread.id, "codex", id(1), null, "disabled");
  sql.graph.projects.unregister(project.id);
  const held = seed(1);
  const heldRun = seed(2);
  capsule(2);
  const pinned = seed(3);
  const final = join(new ArtifactStore(repo).runsDir(), "stopped", "final", "resumable.yaml");
  mkdirSync(dirname(final), { recursive: true });
  writeFileSync(
    final,
    JSON.stringify(
      RunResumable.parse({
        cause: "cancelled",
        resetsAt: null,
        limitWindow: null,
        limitEvidence: null,
        carriers: [],
        limitCode: null,
        session: { harness: "codex", nativeSessionId: id(3), holderProfileId: "disabled" },
        workspace: { kind: "none", root: null },
      }),
    ),
  );
  const discard = seed(4);
  const gc = native();
  expect(
    (await gc(request(true))).reports.find((row) => row.profile_id === "disabled")!.deleted_files,
  ).toEqual([discard]);
  expect(existsSync(discard)).toBe(true);
  const result = await gc(request());
  expect(result.errors).toEqual([]);
  expect(result.freedBytes).toBe(9);
  expect(existsSync(discard)).toBe(false);
  for (const file of [held, heldRun, pinned]) expect(existsSync(file)).toBe(true);
});
it("keeps all homes on unreadable capsule/session references; valid proof permits retirement", async () => {
  const cold = seed(4);
  const path = capsule(2);
  writeFileSync(path, "torn");
  const gc = native();
  expect((await gc(request())).errors.join()).toContain("native retention");
  expect(existsSync(cold)).toBe(true);
  rmSync(path);
  const thread = sql.graph.threads.createThread({ title: "broken", workspace: "in_place" });
  sql.graph.threads.recordSession(thread.id, "codex", id(1));
  sql.store
    .prepare("UPDATE session SET body=? WHERE thread_id=?")
    .run(Buffer.from("bad"), thread.id);
  expect((await gc(request())).errors.length).toBeGreaterThan(0);
  expect(existsSync(cold)).toBe(true);
  sql.store.prepare("DELETE FROM session WHERE thread_id=?").run(thread.id);
  expect((await gc(request())).errors).toEqual([]);
  expect(existsSync(cold)).toBe(false);
});
it("keeps homes during active/setup work, then retires after the idle fence clears", async () => {
  const cold = seed(4);
  const gc = native();
  busy = true;
  expect((await gc(request())).reports.every((row) => row.status === "not_pruned")).toBe(true);
  expect(existsSync(cold)).toBe(true);
  busy = false;
  expect((await gc(request())).freedBytes).toBe(9);
});

it.each(["SQL session", "completed run capsule", "active setup"])(
  "keeps rollouts when %s appears during an asynchronous profile scan",
  async (kind) => {
    const held = seed(4);
    const neighbor = seed(5);
    let admitted = false;
    const gc = native(() => {
      admitted = true;
      if (kind === "active setup") busy = true;
      else {
        const thread = sql.graph.threads.createThread({
          title: "Concurrent admission",
          workspace: "in_place",
        });
        if (kind === "SQL session") sql.graph.threads.recordSession(thread.id, "codex", id(4));
        else capsule(4);
        // The completed-work case is idle again before the unlink check.
        busy = false;
      }
    });
    const interrupted = await gc(request());
    expect(admitted).toBe(true);
    expect(interrupted.errors.join()).toContain("changed");
    expect(interrupted.freedBytes).toBe(0);
    expect(existsSync(held)).toBe(true);
    expect(existsSync(neighbor)).toBe(true);
    busy = false;
    const resumed = await native()(request());
    expect(resumed.errors).toEqual([]);
    expect(existsSync(neighbor)).toBe(false);
    expect(existsSync(held)).toBe(kind !== "active setup");
  },
);
it("integrates native cleanup with GC even without opt-in and discloses it only when requested", async () => {
  const make = () =>
    createRetentionRunner({
      projects: () => sql.graph.projects,
      threads: sql.graph.threads,
      daemonJobs: () => [],
      purgeThread: async () => {},
      hasPurgeLeftovers: () => false,
      nativeHomes: native(),
    });
  seed(4);
  const preview = await make()({ dry_run: true, native_home_report: true });
  expect(
    preview.native_homes?.find((row) => row.profile_id === "disabled")?.deleted_files,
  ).toHaveLength(1);
  const result = await make()({ dry_run: false });
  expect(result.freed_bytes).toBe(9);
  expect(result).not.toHaveProperty("native_homes");
});
it("declares unsupported vendor contracts instead of guessing database ownership", () => {
  const adapters = buildRegistry({ includeFakes: false });
  for (const name of ["claude", "cursor", "agy", "opencode", "copilot"]) {
    const adapter = adapters.get(name);
    expect(adapter, name).toBeDefined();
    expect(adapter!.nativeHomeLifetime).toMatchObject({
      status: "not_pruned",
      reason: expect.stringMatching(/contract|expiry/),
    });
  }
});
