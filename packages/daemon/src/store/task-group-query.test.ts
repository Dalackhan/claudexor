import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskGroupCursor } from "@claudexor/schema";
import type { TaskGroupPageQuery } from "../store-contracts.js";
import type { JobRecord } from "../job-record.js";
import { applyCommandInTx, prepareCommandRow } from "./command-rows.js";
import { SqlCommandQueries } from "./command-queries.js";
import { setGlobalGenerationInTx } from "./generations.js";
import { createPartition, currentGeneration } from "./partitions.js";
import { resourceFixture } from "./test-support/resource-fixture.js";
import { ensureSchema } from "./schema.js";

const GROUP = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const STORE = "22222222-2222-4222-8222-222222222222";
const TIME = "2026-10-22T00:00:00.000Z";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-task-group-query-")));
  // The parent supplies an isolated TMPDIR; retain scratch after resource teardown.
  const f = await resourceFixture(root, { manualTick: true, now: () => new Date(TIME) });
  cleanup.push(() => f.close());
  const global = f.store.transaction(() => {
    const value = createPartition(f.store, "global", { epoch: "a".repeat(32) });
    setGlobalGenerationInTx(f.store, value.pid);
    return value;
  });
  const queries = new SqlCommandQueries(f.store, f.blobs);
  function seed(id: string, patch: Partial<JobRecord> = {}, pid = global.pid, live = true) {
    const row = prepareCommandRow(
      {
        id,
        state: "running",
        runId: `run-${id}`,
        createdAt: TIME,
        params: { mode: "ask", prompt: "body that must never be hydrated", taskGroupId: GROUP },
        ...patch,
      },
      { pid, live, operation: "ask", clientId: "fixture" },
      (bytes) => f.blobs.prepareBody(bytes),
    );
    f.store.transaction(() => applyCommandInTx(f.store, row, "accept"));
  }
  function partition(name: string, epoch: string) {
    return f.store.transaction(() => createPartition(f.store, name, { epoch }));
  }
  function register(id: string, currentPid: number, registryPid = global.pid, status = "active") {
    f.store.transaction(() =>
      f.store
        .prepare(
          "INSERT INTO project(id,pid,root,status,current_pid,created_at,updated_at,body) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          registryPid,
          `/fixture/${id}`,
          status,
          currentPid,
          TIME,
          TIME,
          Buffer.from("unreadable project body"),
        ),
    );
  }
  function page(patch: Partial<TaskGroupPageQuery> = {}) {
    return queries.taskGroupPage({
      taskGroupId: GROUP,
      limit: 2,
      state: null,
      cursor: null,
      storeId: STORE,
      ...patch,
    });
  }
  function cursor(result: ReturnType<typeof page>, index = 0): TaskGroupCursor {
    const row = result.records[index]!;
    return {
      version: 1,
      taskGroupId: GROUP,
      state: null,
      storeId: STORE,
      viewToken: result.viewToken,
      last: { createdAt: row.createdAt, id: row.jobId },
    };
  }
  return { ...f, global, queries, seed, partition, register, page, cursor };
}

describe("SQL taskGroupPage retained selection", () => {
  it("reads an earlier unpublished v3 store without rebuilding its broader indexes", async () => {
    const f = await fixture();
    f.seed("tagged");
    f.seed("untagged", { params: { mode: "ask", prompt: "ungrouped" } });
    // Exact original PR498 predicates at 5b9d6d75; same version, broader membership.
    f.store.db.exec(`DROP INDEX command_task_group; DROP INDEX command_task_group_state;
      CREATE INDEX command_task_group ON command(json_extract(CAST(summary AS TEXT),'$.params.taskGroupId'),created_at DESC,id DESC)
        WHERE live=1 AND kind='product' AND json_valid(CAST(summary AS TEXT));
      CREATE INDEX command_task_group_state ON command(json_extract(CAST(summary AS TEXT),'$.params.taskGroupId'),state,created_at DESC,id DESC)
        WHERE live=1 AND kind='product' AND json_valid(CAST(summary AS TEXT));`);
    const exec = vi.spyOn(f.store.db, "exec");
    ensureSchema(f.store.db);
    expect(exec).not.toHaveBeenCalled();
    for (const state of [null, "running"] as const)
      expect(f.page({ state }).records.map((row) => row.jobId)).toEqual(["tagged"]);
    expect(
      f.store.db
        .prepare("SELECT sum(ncell) AS n FROM dbstat WHERE name='command_task_group'")
        .get(),
    ).toEqual({ n: 2 }); // Existing v3 keeps its original storage cost.
  });

  it.each([1, 10])(
    "uses actual ordered expression indexes at %ix unrelated history with raw summaries and no body hydration",
    async (scale) => {
      const f = await fixture();
      for (let i = 0; i < scale * 100; i++)
        f.seed(`job-unrelated-${i}`, {
          params: { mode: "ask", taskGroupId: OTHER, prompt: "x".repeat(5000) },
        });
      for (const id of ["a", "b", "c", "d"])
        f.seed(`job-${id}`, {
          state: id === "b" ? "queued" : "running",
          runId: id === "b" ? undefined : `run-${id}`,
        });
      f.store.transaction(() => {
        const insert = f.store.prepare(
          "INSERT INTO command(id,pid,operation,state,created_at,summary,params_sha,kind,live) VALUES(?,?,'ask','running',?,?,'missing-params','product',1)",
        );
        for (const [id, bytes] of [
          ["raw-null", Buffer.from([0])],
          ["raw-benchmark", Buffer.alloc(400, 0x62)],
          ["raw-truncated-json", Buffer.from('{"params":')],
        ] as const)
          expect(insert.run(id, f.global.pid, TIME, bytes).changes).toBe(1);
      });
      expect(
        f.store
          .prepare("SELECT count(*) AS n FROM command WHERE json_valid(CAST(summary AS TEXT))=0")
          .get(),
      ).toEqual({ n: 3 });
      // Poison every body pointer after acceptance. A collection must not touch them.
      f.store.transaction(() =>
        f.store
          .prepare("UPDATE command SET params_sha='missing-params',result_sha='missing-result'")
          .run(),
      );
      const bodies = vi.spyOn(f.blobs, "read");
      const detail = vi.spyOn(f.queries, "getByRunId");
      const legacy = vi.spyOn(f.queries, "publicList");
      const unfiltered = vi.spyOn(f.queries, "select");
      const count = vi.spyOn(f.queries, "count");
      const prepare = f.store.prepare.bind(f.store);
      const reads: Array<{ sql: string; args: unknown[]; rows: number }> = [];
      function queryPlan(read: (typeof reads)[number]) {
        const statement = prepare(`EXPLAIN QUERY PLAN ${read.sql}`);
        const rows = Reflect.apply(statement.all, statement, read.args) as ReturnType<
          typeof statement.all
        >;
        return rows.map((row) => String(row["detail"])).join("\n");
      }
      const instrumented = new Set<object>();
      const prepared = vi.spyOn(f.store, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (/\bFROM\s+command\b/i.test(sql) && !instrumented.has(statement)) {
          instrumented.add(statement);
          const all = statement.all.bind(statement);
          vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
            const rows = Reflect.apply(all, statement, args) as ReturnType<typeof statement.all>;
            reads.push({ sql, args, rows: rows.length });
            return rows;
          });
        }
        return statement;
      });
      for (const state of [null, "running"] as const) {
        reads.length = 0;
        const first = f.page({ state });
        expect(first.records.map((row) => row.jobId)).toEqual(
          state ? ["job-d", "job-c", "job-a"] : ["job-d", "job-c", "job-b"],
        );
        expect(first.hasMore).toBe(true);
        expect(reads).toHaveLength(1);
        const read = reads[0]!;
        expect(read.rows).toBeLessThanOrEqual(3);
        expect(read.sql).toMatch(/\bLIMIT\b/i);
        expect(read.sql).toContain("AND json_valid(CAST(c.summary AS TEXT))");
        expect(read.sql).toMatch(/created_at\s+DESC\s*,\s*(?:\w+\.)?id\s+DESC/i);
        const projection = read.sql.split(/\bFROM\s+command\b/i)[0]!;
        expect(projection).not.toMatch(
          /SELECT\s+(?:\w+\.)?\*|\b(params_sha|result_sha|run_dir|request|resolution)\b|\b(?:\w+\.)?summary\s*(?:,|AS\s+summary)/i,
        );
        expect(projection).not.toMatch(/(?:SELECT|,)\s*(?:\w+\.)?summary\b/i);
        const plan = queryPlan(read);
        expect(plan).toMatch(
          new RegExp(`\\b${state ? "command_task_group_state" : "command_task_group"}\\b`),
        );
        expect(plan).not.toMatch(/TEMP B-TREE|SCAN\s+(?:c|command)\b/i);
        expect(first.records.every((row) => row.taskGroupId === GROUP)).toBe(true);
        const next = f.page({ state, cursor: { ...f.cursor(first, 1), state } });
        expect(next.records.map((row) => row.jobId)).toEqual(
          state ? ["job-a"] : ["job-b", "job-a"],
        );
        expect(next.hasMore).toBe(false);
        expect(reads.every((read) => read.rows <= 3)).toBe(true);
        const keysetRead = reads.at(-1)!;
        const keysetPlan = queryPlan(keysetRead);
        expect(keysetPlan).toMatch(
          new RegExp(`\\b${state ? "command_task_group_state" : "command_task_group"}\\b`),
        );
        expect(keysetPlan).not.toMatch(/TEMP B-TREE|SCAN\s+(?:c|command)\b/i);
      }
      expect(bodies).not.toHaveBeenCalled();
      expect(detail).not.toHaveBeenCalled();
      expect(legacy).not.toHaveBeenCalled();
      expect(unfiltered).not.toHaveBeenCalled();
      expect(count).not.toHaveBeenCalled();
      expect(prepared.mock.calls.map(([sql]) => sql).join("\n")).not.toMatch(
        /\b(?:FROM|JOIN)\s+(?:interaction|event|blob|artifact)\b|\bcount\s*\(/i,
      );
    },
  );

  it("uses the last key even when pruned, tolerates new inserts and permits a changed limit", async () => {
    const f = await fixture();
    for (const id of ["a", "b", "c", "d"]) f.seed(`job-${id}`);
    const first = f.page();
    const cursor = f.cursor(first, 1);
    f.store.transaction(() =>
      f.store.prepare("DELETE FROM command WHERE id=?").run(cursor.last.id),
    );
    f.seed("job-z", { createdAt: "2026-10-23T00:00:00.000Z" });
    const next = f.page({ cursor, limit: 1 });
    expect(next.viewToken).toBe(first.viewToken);
    expect(next.records.map((row) => row.jobId)).toEqual(["job-b", "job-a"]);
    expect(next.hasMore).toBe(true);
    expect(f.page({ cursor: f.cursor(next), limit: 200 }).records.map((row) => row.jobId)).toEqual([
      "job-a",
    ]);
  });

  it("admits only current global and registry-active project generations, even with stale live bits", async () => {
    const f = await fixture();
    const current = f.partition("project:current", "b".repeat(32));
    const retiredProject = f.partition(current.name, "c".repeat(32));
    const oldGlobal = f.partition("global", "d".repeat(32));
    const staleProject = f.partition("project:stale", "e".repeat(32));
    const orphan = f.partition("project:orphan", "f".repeat(32));
    const archived = f.partition("project:archived", "1".repeat(32));
    const quarantined = f.partition("project:quarantined", "2".repeat(32));
    const inactive = f.partition("project:inactive", "3".repeat(32));
    f.register("current", current.pid);
    f.register("stale", staleProject.pid, oldGlobal.pid);
    f.register("archived", archived.pid);
    f.register("quarantined", quarantined.pid);
    f.register("inactive", inactive.pid, f.global.pid, "archived");
    f.store.transaction(() => {
      f.store.prepare("UPDATE partition SET status='archived' WHERE id=?").run(archived.pid);
      f.store.prepare("UPDATE partition SET status='quarantined' WHERE id=?").run(quarantined.pid);
    });
    expect(currentGeneration(f.store, current.name)?.pid).toBe(current.pid);
    for (const hidden of [staleProject, orphan, archived, quarantined, inactive])
      expect(currentGeneration(f.store, hidden.name)).toBeNull();
    f.seed("job-global");
    for (const [id, p] of Object.entries({
      current,
      retiredProject,
      oldGlobal,
      staleProject,
      orphan,
      archived,
      quarantined,
      inactive,
    }))
      f.seed(`job-${id}`, {}, p.pid, true);
    f.seed("job-not-live", {}, f.global.pid, false);
    f.seed("job-untagged", { params: { mode: "ask", prompt: "no group" } });
    f.seed("delivery-copy");
    f.seed("job-model", { params: { kind: "model", taskGroupId: GROUP } });
    f.seed("job-maintenance", {
      params: { kind: "harness_maintenance", harness: "codex", taskGroupId: GROUP },
    });
    expect(
      f
        .page({ limit: 200 })
        .records.map((row) => row.jobId)
        .sort(),
    ).toEqual(["job-current", "job-global"]);
    const view = f.page().viewToken;
    f.partition("project:another-orphan", "4".repeat(32));
    expect(f.page().viewToken).toBe(view);
  });

  it("preserves view identity on relink, but rejects project/global generation changes and archive/quarantine", async () => {
    const f = await fixture();
    const project = f.partition("project:stable", "b".repeat(32));
    f.register("stable", project.pid);
    f.seed("job-p", {}, project.pid);
    f.seed("job-a");
    const first = f.page();
    const cursor = f.cursor(first);
    f.store.transaction(() =>
      f.store
        .prepare("UPDATE project SET root=?,updated_at=? WHERE id='stable'")
        .run("/fixture/relinked", "2026-10-23T00:00:00.000Z"),
    );
    expect(f.page({ cursor }).viewToken).toBe(first.viewToken);
    f.store.transaction(() =>
      f.store.prepare("UPDATE project SET status='archived' WHERE id='stable'").run(),
    );
    expect(() => f.page({ cursor })).toThrow(
      expect.objectContaining({ code: expect.stringMatching(/stale.*cursor|cursor.*stale/) }),
    );
    f.store.transaction(() =>
      f.store.prepare("UPDATE project SET status='active' WHERE id='stable'").run(),
    );
    for (const status of ["archived", "quarantined"]) {
      f.store.transaction(() =>
        f.store.prepare("UPDATE partition SET status=? WHERE id=?").run(status, project.pid),
      );
      expect(() => f.page({ cursor })).toThrow(
        expect.objectContaining({ code: expect.stringMatching(/stale.*cursor|cursor.*stale/) }),
      );
      f.store.transaction(() =>
        f.store.prepare("UPDATE partition SET status='ready' WHERE id=?").run(project.pid),
      );
    }
    const replacement = f.partition(project.name, "c".repeat(32));
    f.store.transaction(() =>
      f.store.prepare("UPDATE project SET current_pid=? WHERE id='stable'").run(replacement.pid),
    );
    expect(() => f.page({ cursor })).toThrow(
      expect.objectContaining({ code: expect.stringMatching(/stale.*cursor|cursor.*stale/) }),
    );
    const fresh = f.page();
    const global = f.partition("global", "d".repeat(32));
    f.store.transaction(() => setGlobalGenerationInTx(f.store, global.pid));
    expect(() => f.page({ cursor: f.cursor(fresh) })).toThrow(
      expect.objectContaining({ code: expect.stringMatching(/stale.*cursor|cursor.*stale/) }),
    );
  });

  it("hashes sorted served identities independently of registry row order and rejects an added served project", async () => {
    const f = await fixture();
    const z = f.partition("project:z", "b".repeat(32));
    const a = f.partition("project:a", "c".repeat(32));
    f.register("z", z.pid);
    f.register("a", a.pid);
    f.seed("job-a");
    const first = f.page();
    const cursor = f.cursor(first);
    f.store.transaction(() => {
      f.store
        .prepare("UPDATE project SET created_at='2026-10-21T00:00:00.000Z' WHERE id='a'")
        .run();
      f.store
        .prepare("UPDATE project SET created_at='2026-10-23T00:00:00.000Z' WHERE id='z'")
        .run();
    });
    expect(f.page({ cursor }).viewToken).toBe(first.viewToken);
    f.register("alias-of-a", a.pid);
    expect(f.page({ cursor }).viewToken).toBe(first.viewToken);
    const added = f.partition("project:added", "d".repeat(32));
    f.register("added", added.pid);
    expect(() => f.page({ cursor })).toThrow(
      expect.objectContaining({ code: expect.stringMatching(/stale.*cursor|cursor.*stale/) }),
    );
    expect(f.page().viewToken).not.toBe(first.viewToken);
  });

  it.each(["group", "state", "store"] as const)(
    "rejects wrong cursor %s binding before command selection",
    async (binding) => {
      const f = await fixture();
      f.seed("job-a");
      const cursor = f.cursor(f.page());
      const changed = {
        ...cursor,
        ...(binding === "group"
          ? { taskGroupId: OTHER }
          : binding === "state"
            ? { state: "queued" as const }
            : { storeId: OTHER }),
      };
      const prepare = vi.spyOn(f.store, "prepare");
      expect(() => f.page({ cursor: changed })).toThrow(
        expect.objectContaining({ code: expect.any(String) }),
      );
      expect(
        prepare.mock.calls.map(([sql]) => sql).filter((sql) => /\bFROM\s+command\b/i.test(sql)),
      ).toEqual([]);
    },
  );

  it("does not turn a registry read failure into an empty retained view", async () => {
    const f = await fixture();
    const prepare = f.store.prepare.bind(f.store);
    vi.spyOn(f.store, "prepare").mockImplementation((sql) => {
      if (/\b(meta|partition|project)\b/i.test(sql)) throw new Error("registry unavailable");
      return prepare(sql);
    });
    expect(() => f.page()).toThrow("registry unavailable");
  });
});
