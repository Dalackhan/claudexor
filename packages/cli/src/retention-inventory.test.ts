import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { projectRuntimeDir } from "@claudexor/util";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { createRetentionRunner } from "./retention-service.js";

let root: string;
let configBefore: string | undefined;
let sql: Awaited<ReturnType<typeof sqlFixture>>;
const old = new Date("2020-01-01");
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-retention-inventory-")));
  configBefore = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
  mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
  writeFileSync(
    join(process.env.CLAUDEXOR_CONFIG_DIR, "config.yaml"),
    "retention:\n  keep_last_runs_per_project: 0\n",
  );
  sql = await sqlFixture(join(root, "sql"));
});
afterEach(async () => {
  await sql?.close();
  if (configBefore === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
  else process.env.CLAUDEXOR_CONFIG_DIR = configBefore;
  rmSync(root, { recursive: true, force: true });
});
function repo(name: string) {
  const path = join(root, name);
  mkdirSync(path);
  return path;
}
function run(repoRoot: string, id: string, terminal = true) {
  const path = join(new ArtifactStore(repoRoot).runsDir(), id);
  mkdirSync(join(path, "final"), { recursive: true });
  if (terminal) writeFileSync(join(path, "final", "failure.yaml"), "terminal failure");
  utimesSync(path, old, old);
  return path;
}
function runner(cap?: number) {
  return createRetentionRunner({
    projects: () => sql.graph.projects,
    threads: sql.graph.threads,
    daemonJobs: () => [],
    purgeThread: async () => {
      throw new Error("unexpected purge");
    },
    hasPurgeLeftovers: () => false,
    maxDeletionsPerPass: cap,
  });
}
it("reclaims old unregistered runs, preserves unproven and young runs, previews without writes", async () => {
  const project = repo("ghost");
  const expired = run(project, "expired");
  const unknown = run(project, "unknown", false);
  const young = run(project, "young");
  utimesSync(young, new Date(), new Date());
  const gc = runner();
  const preview = await gc({ dry_run: true });
  expect(preview.deleted_runs.map((row) => row.run_id)).toEqual(["expired"]);
  expect(preview.deleted_runs[0]!.project_root).toBe(projectRuntimeDir(project));
  expect(existsSync(join(expired, "final", "failure.yaml"))).toBe(true);
  const result = await gc({ dry_run: false });
  expect(result.deleted_runs.map((row) => row.run_id)).toEqual(["expired"]);
  expect(readFileSync(join(expired, "tombstone.yaml"), "utf8")).toContain("expired");
  expect(existsSync(join(expired, "final"))).toBe(false);
  expect(existsSync(unknown)).toBe(true);
  expect(existsSync(join(young, "final"))).toBe(true);
});
it("retains archived thread lineage and pending interactions while deleting an unreferenced neighbor", async () => {
  const projectRoot = repo("archived");
  const project = sql.graph.projects.register({
    root: projectRoot,
    clientId: "test",
    idempotencyKey: "project",
  }).project;
  const thread = sql.graph.threads.createThread({
    title: "retained",
    repoRoot: projectRoot,
    workspace: "in_place",
  });
  const turn = sql.graph.threads.createTurn(thread.id, "prompt", {
    parentRunId: "parent",
    answersPlanRunId: "answer",
    planRunId: "plan",
  });
  sql.graph.threads.bindTurnRun(turn.id, "bound");
  for (const id of ["parent", "answer", "plan", "bound", "pending", "unreferenced"])
    run(projectRoot, id);
  const pid = sql.graph.projects.partition(project.id)!.pid;
  sql.store
    .prepare("INSERT INTO interaction(id,pid,run_id,state,request) VALUES(?,?,?,?,?)")
    .run("pending", pid, "pending", "pending", Buffer.from("{}"));
  sql.graph.projects.unregister(project.id);
  expect(sql.graph.threads.listThreads()).toEqual([]);
  const result = await runner()({ dry_run: false });
  expect(result.deleted_runs.map((row) => row.run_id)).toEqual(["unreferenced"]);
  expect(result.kept.referenced).toBe(5);
});
it("fails closed on corrupt archived thread references before deleting any namespace", async () => {
  const projectRoot = repo("broken");
  const project = sql.graph.projects.register({
    root: projectRoot,
    clientId: "test",
    idempotencyKey: "project",
  }).project;
  const thread = sql.graph.threads.createThread({
    title: "broken",
    repoRoot: projectRoot,
    workspace: "in_place",
  });
  sql.graph.projects.unregister(project.id);
  sql.store.prepare("UPDATE thread SET body=? WHERE id=?").run(Buffer.from("bad json"), thread.id);
  const path = run(repo("other"), "otherwise-deletable");
  await expect(runner()({ dry_run: false })).rejects.toThrow();
  expect(existsSync(join(path, "final"))).toBe(true);
});
it("preserves unavailable generations and never follows a linked runtime namespace", async () => {
  const projectRoot = repo("quarantined");
  const project = sql.graph.projects.register({
    root: projectRoot,
    clientId: "test",
    idempotencyKey: "project",
  }).project;
  sql.store
    .prepare("UPDATE partition SET status='quarantined' WHERE id=?")
    .run(sql.graph.projects.partition(project.id)!.pid);
  const protectedRun = run(projectRoot, "protected");
  const linkedRepo = repo("linked");
  const outside = repo("outside");
  mkdirSync(join(outside, "runs", "old", "final"), { recursive: true });
  writeFileSync(join(outside, "runs", "old", "final", "failure.yaml"), "keep");
  utimesSync(join(outside, "runs", "old"), old, old);
  symlinkSync(outside, projectRuntimeDir(linkedRepo), "dir");
  run(repo("ordinary"), "delete");
  const result = await runner()({ dry_run: false });
  expect(result.deleted_runs.map((row) => row.run_id)).toEqual(["delete"]);
  expect(existsSync(join(protectedRun, "final"))).toBe(true);
  expect(existsSync(join(outside, "runs", "old", "final"))).toBe(true);
});
it("continues bounded passes until all eligible orphan runs retire", async () => {
  const projectRoot = repo("many");
  for (let i = 0; i < 5; i++) run(projectRoot, `run-${i}`);
  const gc = runner(2);
  expect((await gc({ dry_run: false })).deleted_runs).toHaveLength(2);
  expect(gc.hasMore!()).toBe(true);
  expect((await gc({ dry_run: false })).deleted_runs).toHaveLength(2);
  expect(gc.hasMore!()).toBe(true);
  expect((await gc({ dry_run: false })).deleted_runs).toHaveLength(1);
  expect(gc.hasMore!()).toBe(false);
});

it("keeps each capped receipt's continuation signal across queued manual passes", async () => {
  const projectRoot = repo("queued");
  for (let i = 0; i < 3; i++) run(projectRoot, `queued-${i}`);
  const gc = runner(2);
  const [scheduled, manual] = await Promise.all([gc({ dry_run: false }), gc({ dry_run: false })]);
  expect(scheduled.deleted_runs).toHaveLength(2);
  expect(manual.deleted_runs).toHaveLength(1);
  expect(gc.hasMore!(scheduled)).toBe(true);
  expect(gc.hasMore!(manual)).toBe(false);
  expect(gc.hasMore!()).toBe(false);
});
