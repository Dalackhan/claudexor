import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runRetentionPass, type RetentionRunRecord } from "./retention.js";

let afterWalk: (path: string) => void = () => {};
vi.mock("./retention-bytes.js", async (original) => {
  const actual = await original<typeof import("./retention-bytes.js")>();
  return {
    treeReclaimableBytes: async (...args: Parameters<typeof actual.treeReclaimableBytes>) => {
      const bytes = await actual.treeReclaimableBytes(...args);
      afterWalk(args[0]);
      return bytes;
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  afterWalk = () => {};
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(["reference", "active record", "work product", "custody", "age", "terminal evidence"])(
  "rechecks %s after asynchronous byte inventory, while still retiring an unchanged neighbor",
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "retention-recheck-"));
    roots.push(root);
    const runsDir = join(root, "runs");
    const held = join(runsDir, "held");
    const neighbor = join(runsDir, "neighbor");
    const old = new Date("2020-01-01");
    for (const path of [held, neighbor]) {
      mkdirSync(join(path, "final"), { recursive: true });
      writeFileSync(join(path, "final", "failure.yaml"), "terminal evidence");
      utimesSync(path, old, old);
    }
    const referenced = new Set<string>();
    const records: RetentionRunRecord[] = [];
    let changed = false;
    afterWalk = (path) => {
      if (path !== held) return;
      changed = true;
      if (kind === "reference") referenced.add("held");
      if (kind === "active record") records.push({ runId: "held", state: "running" });
      if (kind === "work product")
        writeFileSync(
          join(held, "final", "work_product.yaml"),
          "kind: patch\nmeta:\n  apply_state: pending\n",
        );
      if (kind === "custody")
        writeFileSync(join(held, "final", "retained-envelope.json"), "unreadable pointer");
      if (kind === "age") utimesSync(held, new Date(), new Date());
      if (kind === "terminal evidence") rmSync(join(held, "final", "failure.yaml"));
    };
    const receipt = await runRetentionPass(
      { runsMaxAgeDays: 30, reviewsMaxAgeDays: 14, keepLastRunsPerProject: 0 },
      { dry_run: false },
      {
        projects: () => [{ root, runsDir, reviewsDir: null }],
        records: () => records,
        referencedRunIds: () => referenced,
      },
    );
    expect(changed).toBe(true);
    expect(receipt.deleted_runs.map((run) => run.run_id)).toEqual(["neighbor"]);
    expect(existsSync(join(held, "final"))).toBe(true);
    expect(existsSync(join(neighbor, "tombstone.yaml"))).toBe(true);
    const reason = {
      reference: "referenced",
      "active record": "active",
      "work product": "actionable",
      custody: "actionable",
      age: "young",
      "terminal evidence": "unknown_state",
    } as const;
    expect(receipt.kept[reason[kind as keyof typeof reason]]).toBe(1);
  },
);

it("keeps an honest partial run receipt when SQL ownership changes during the next byte walk", async () => {
  const root = mkdtempSync(join(tmpdir(), "retention-partial-"));
  roots.push(root);
  const runsDir = join(root, "runs");
  const paths = ["first", "second"].map((id) => join(runsDir, id));
  for (const path of paths) {
    mkdirSync(join(path, "final"), { recursive: true });
    writeFileSync(join(path, "final", "failure.yaml"), "terminal");
    utimesSync(path, new Date("2020-01-01"), new Date("2020-01-01"));
  }
  let current = true;
  let retry = false;
  afterWalk = () => {
    if (paths.some((path) => existsSync(join(path, "tombstone.yaml")))) current = false;
  };
  const receipt = await runRetentionPass(
    { runsMaxAgeDays: 30, reviewsMaxAgeDays: 14, keepLastRunsPerProject: 0 },
    { dry_run: false },
    {
      projects: () => [{ root, runsDir, reviewsDir: null }],
      records: () => [],
      referencedRunIds: () => new Set(),
      referencesCurrent: () => current,
      onTruncated: () => {
        retry = true;
      },
    },
  );
  expect(receipt.deleted_runs).toHaveLength(1);
  expect(receipt.freed_bytes).toBe(8);
  expect(receipt.errors.join()).toContain("references changed");
  expect(retry).toBe(true);
  expect(paths.filter((path) => existsSync(join(path, "final")))).toHaveLength(1);
});
