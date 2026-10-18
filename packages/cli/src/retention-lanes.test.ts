// Lane sweeping observes live ownership at the synchronous deletion boundary.
// Orphan lane sweeping (INV-034 owner c) under ordinary unrelated SQL writes.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { noProjectRepoRoot, projectRuntimeDir } from "@claudexor/util";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { createRetentionRunner } from "./retention-service.js";
import { sqlActivityRecords } from "./sql-daemon-queries.js";

let root: string;
let before: string | undefined;
let sql: Awaited<ReturnType<typeof sqlFixture>>;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-opus-lanes-")));
  before = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
  mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
  sql = await sqlFixture(join(root, "sql"));
});
afterEach(async () => {
  await sql.close();
  if (before === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
  else process.env.CLAUDEXOR_CONFIG_DIR = before;
  rmSync(root, { recursive: true, force: true });
});

it("sweeps an orphan in the first pass while unrelated thread writes continue", async () => {
  const lane = join(
    projectRuntimeDir(noProjectRepoRoot()),
    "lanes",
    "th-000000000001",
    "default",
    "home",
  );
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, "session.jsonl"), "orphaned lane state");
  const busy = sql.graph.threads.createThread({ title: "busy", workspace: "in_place" });
  const held = join(projectRuntimeDir(noProjectRepoRoot()), "lanes", busy.id, "default", "home");
  mkdirSync(held, { recursive: true });
  let writes = 0;
  // An unrelated metadata write every millisecond, like a busy daemon's routine traffic.
  const timer = setInterval(() => {
    sql.graph.threads.updateThread(busy.id, { title: `busy ${++writes}` });
  }, 1);
  const outcomes: Array<{ pass: number; laneExists: boolean; errors: string[] }> = [];
  try {
    const gc = createRetentionRunner({
      projects: () => sql.graph.projects,
      threads: sql.graph.threads,
      daemonJobs: () => sqlActivityRecords(sql.store),
      purgeThread: async () => {},
      hasPurgeLeftovers: () => false,
    });
    for (let pass = 1; pass <= 1; pass++) {
      const receipt = await gc({ dry_run: false });
      outcomes.push({ pass, laneExists: existsSync(lane), errors: receipt.errors });
    }
  } finally {
    clearInterval(timer);
  }
  expect(writes).toBeGreaterThan(0);
  expect(outcomes).toEqual([{ pass: 1, laneExists: false, errors: [] }]);
  expect(existsSync(held)).toBe(true);
  expect(existsSync(lane)).toBe(false);
});

it("names the root when live lane ownership cannot be read", async () => {
  const repoRoot = noProjectRepoRoot();
  const lane = join(projectRuntimeDir(repoRoot), "lanes", "th-000000000001", "default", "home");
  mkdirSync(lane, { recursive: true });
  vi.spyOn(sql.graph.threads, "retentionLaneThreadIds").mockImplementation(() => {
    throw new Error("partition is pending recovery");
  });
  const gc = createRetentionRunner({
    projects: () => sql.graph.projects,
    threads: sql.graph.threads,
    daemonJobs: () => sqlActivityRecords(sql.store),
    purgeThread: async () => {},
    hasPurgeLeftovers: () => false,
  });
  const receipt = await gc({ dry_run: false });
  expect(existsSync(lane)).toBe(true);
  expect(receipt.errors.join("\n")).toContain(`lane sweep skipped for ${repoRoot}`);
});
