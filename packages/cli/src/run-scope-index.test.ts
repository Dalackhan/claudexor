import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  mintRunScopeMarker,
  type KnownProcessIdentity,
  type ProcessIdentity,
  type ProcessTableReader,
  type ProcessTableRow,
  type ScopeReapOptions,
  type ScopeReapOutcome,
} from "@claudexor/core";
import { DaemonRunScopeIndex, RUN_SCOPE_INDEX_FILE } from "./run-scope-index.js";
import { armDaemonLifecycle, runStartupCrashGc } from "./daemon-lifecycle.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-scope-index-"));
  dirs.push(dir);
  return dir;
}

const T0 = "Mon Oct 12 14:00:00 2026";
const T1 = "Mon Oct 12 14:00:05 2026";

function known(pid: number, token: string): KnownProcessIdentity {
  return {
    status: "known",
    pid,
    platform: "linux",
    source: "procfs_stat",
    startToken: `linux:${token}`,
    processGroupId: pid,
  };
}

function settledOutcome(over: Partial<ScopeReapOutcome> = {}): ScopeReapOutcome {
  return {
    coverage: "marker+capture",
    census: "ok",
    censusFailure: null,
    ended: [],
    survivors: [],
    unreadable: [],
    reusedGroups: [],
    settled: true,
    restricted: false,
    durationMs: 1,
    ...over,
  };
}

/** A fake reaper that records every marker it was asked to end. */
function fakeReaper(outcomes: Record<string, ScopeReapOutcome> = {}) {
  const calls: ScopeReapOptions[] = [];
  return {
    calls,
    reap: async (opts: ScopeReapOptions) => {
      calls.push(opts);
      return outcomes[opts.marker] ?? settledOutcome();
    },
  };
}

function fakeTable(rows: ProcessTableRow[]): ProcessTableReader {
  return {
    async snapshot() {
      return rows;
    },
    async row(pid) {
      return rows.find((r) => r.pid === pid) ?? null;
    },
  };
}

function fakeIdentity(live: Record<number, KnownProcessIdentity>) {
  return {
    async read(pid: number): Promise<ProcessIdentity> {
      return live[pid] ?? { status: "missing", pid, platform: "linux" };
    },
  };
}

function readIndex(root: string) {
  return JSON.parse(readFileSync(join(root, RUN_SCOPE_INDEX_FILE), "utf8")) as {
    entries: Array<Record<string, unknown>>;
  };
}

describe("DaemonRunScopeIndex", () => {
  it("records the scope durably BEFORE returning the marker, with the daemon's identity as owner", async () => {
    const root = tempRoot();
    const me = known(process.pid, "7");
    const index = new DaemonRunScopeIndex({
      path: join(root, RUN_SCOPE_INDEX_FILE),
      owner: async () => me,
      reap: fakeReaper().reap,
      table: fakeTable([]),
      roots: () => [],
    });
    const { marker } = await index.open("run-1");
    const file = readIndex(root);
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0]).toMatchObject({
      marker,
      run_id: "run-1",
      state: "open",
      owner: me,
      captured: [],
      scope_start: null,
    });
  });

  it("captures a live root's descendants (pid, pgid, birth) and the scope start on the tick, persisted", async () => {
    const root = tempRoot();
    const rows: ProcessTableRow[] = [
      { pid: 100, ppid: process.pid, pgid: 100, birth: T0 },
      { pid: 200, ppid: 100, pgid: 200, birth: T1 }, // a setsid shell
      { pid: 210, ppid: 200, pgid: 200, birth: T1 }, // its tool
      { pid: 999, ppid: 1, pgid: 999, birth: T0 }, // unrelated
    ];
    const index = new DaemonRunScopeIndex({
      path: join(root, RUN_SCOPE_INDEX_FILE),
      owner: async () => known(process.pid, "7"),
      reap: fakeReaper().reap,
      table: fakeTable(rows),
      roots: () => [{ pid: 100, scopeMarker: marker }],
    });
    const { marker } = await index.open("run-1");
    await index.captureTick();
    const entry = index.list()[0]!;
    expect(entry.scope_start).toBe(T0);
    expect(entry.captured).toEqual([
      { pid: 100, pgid: 100, birth: T0 },
      { pid: 200, pgid: 200, birth: T1 },
      { pid: 210, pgid: 200, birth: T1 },
    ]);
    // Idempotent: a second tick adds nothing.
    await index.captureTick();
    expect(index.list()[0]!.captured).toHaveLength(3);
    expect(readIndex(root).entries[0]!["captured"]).toHaveLength(3);
  });

  it("settle hands the recorded rows to the reaper, retires a settled entry and keeps an unresolved one with its outcome", async () => {
    const root = tempRoot();
    const path = join(root, RUN_SCOPE_INDEX_FILE);
    const reaper = fakeReaper();
    const index = new DaemonRunScopeIndex({
      path,
      owner: async () => known(process.pid, "7"),
      reap: reaper.reap,
      table: fakeTable([{ pid: 100, ppid: process.pid, pgid: 100, birth: T0 }]),
      roots: () => [{ pid: 100, scopeMarker: marker }],
    });
    const { marker } = await index.open("run-1");
    await index.captureTick();
    const outcome = await index.settle("run-1", marker);
    expect(outcome.settled).toBe(true);
    expect(reaper.calls[0]).toMatchObject({
      marker,
      scopeStart: T0,
      captured: [{ pid: 100, pgid: 100, birth: T0 }],
    });
    expect(readIndex(root).entries).toEqual([]);

    // An unsettled reap keeps the entry as unresolved with its outcome summary.
    const survivor = settledOutcome({
      settled: false,
      survivors: [{ pid: 4711, startToken: "ps:x" }],
      reusedGroups: [77],
    });
    const second = new DaemonRunScopeIndex({
      path,
      owner: async () => known(process.pid, "7"),
      reap: fakeReaper({}).reap,
      table: fakeTable([]),
      roots: () => [],
    });
    const { marker: m2 } = await second.open("run-2");
    const kept = new DaemonRunScopeIndex({
      path,
      owner: async () => known(process.pid, "7"),
      reap: fakeReaper({ [m2]: survivor }).reap,
      table: fakeTable([]),
      roots: () => [],
    });
    await kept.settle("run-2", m2);
    expect(readIndex(root).entries[0]).toMatchObject({
      marker: m2,
      state: "unresolved",
      outcome: { survivors: [4711], reused_groups: [77], ended: 0 },
    });
  });

  it("start: reaps a dead generation's scopes, spares a live owner's, never touches an unindexed marker, and tolerates a missing or corrupt file", async () => {
    const root = tempRoot();
    const path = join(root, RUN_SCOPE_INDEX_FILE);
    const deadDaemon = known(4242, "4242");
    const liveDaemon = known(5151, "5151");
    const deadMarker = mintRunScopeMarker();
    const liveMarker = mintRunScopeMarker();
    const strangerMarker = mintRunScopeMarker(); // grammar-shaped, NOT in the index
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        entries: [
          {
            marker: deadMarker,
            run_id: "run-dead",
            owner: deadDaemon,
            state: "open",
            opened_at: "x",
            scope_start: T0,
            captured: [{ pid: 210, pgid: 200, birth: T1 }],
          },
          {
            marker: liveMarker,
            run_id: "run-live",
            owner: liveDaemon,
            state: "open",
            opened_at: "x",
            scope_start: null,
            captured: [],
          },
        ],
      }),
    );
    const reaper = fakeReaper();
    const index = new DaemonRunScopeIndex({
      path,
      identity: fakeIdentity({ 5151: liveDaemon }), // 4242 is gone (or recycled)
      reap: reaper.reap,
      table: fakeTable([]),
      roots: () => [],
    });
    const actions = await index.settleDeadOwners();
    expect(reaper.calls.map((c) => c.marker)).toEqual([deadMarker]);
    expect(reaper.calls[0]).toMatchObject({
      scopeStart: T0,
      captured: [{ pid: 210, pgid: 200, birth: T1 }],
    });
    expect(reaper.calls.some((c) => c.marker === strangerMarker)).toBe(false);
    expect(actions.join("\n")).toMatch(/run-dead: settled/);
    expect(actions.join("\n")).toMatch(/run-live: owner 5151 is live; untouched/);
    const after = readIndex(root).entries;
    expect(after.map((e) => e["marker"])).toEqual([liveMarker]);

    // Crash before the first index write: no file, nothing to do.
    const empty = new DaemonRunScopeIndex({
      path: join(root, "absent.json"),
      reap: reaper.reap,
      table: fakeTable([]),
      roots: () => [],
    });
    expect(await empty.settleDeadOwners()).toEqual([]);
    // Corrupt file: start empty, never throw.
    const corruptPath = join(root, "corrupt.json");
    writeFileSync(corruptPath, "{not json");
    const corrupt = new DaemonRunScopeIndex({
      path: corruptPath,
      reap: reaper.reap,
      table: fakeTable([]),
      roots: () => [],
    });
    expect(await corrupt.settleDeadOwners()).toEqual([]);
  });

  it("start: a leader that exited before any snapshot is reaped by marker alone (empty capture, no floor)", async () => {
    const root = tempRoot();
    const path = join(root, RUN_SCOPE_INDEX_FILE);
    const dead = known(4242, "4242");
    const marker = mintRunScopeMarker();
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        entries: [
          {
            marker,
            run_id: "run-short",
            owner: dead,
            state: "open",
            opened_at: "x",
            scope_start: null,
            captured: [],
          },
        ],
      }),
    );
    const reaper = fakeReaper();
    const index = new DaemonRunScopeIndex({
      path,
      identity: fakeIdentity({}),
      reap: reaper.reap,
      table: fakeTable([]),
      roots: () => [],
    });
    await index.settleDeadOwners();
    expect(reaper.calls).toHaveLength(1);
    expect(reaper.calls[0]).toMatchObject({ marker, captured: [], scopeStart: null });
    expect(existsSync(path)).toBe(true);
    expect(readIndex(root).entries).toEqual([]);
  });
});

describe("daemon lifecycle wiring", () => {
  it("startup crash GC settles scopes BEFORE the workspace sweep and discloses each action", async () => {
    const root = tempRoot();
    const order: string[] = [];
    await runStartupCrashGc({
      daemonDir: root,
      diagnostics: {
        record: (record) => {
          order.push(`${record.stage}:${record.message}`);
          return true;
        },
      },
      knownProjectRoots: () => {
        order.push("sweep");
        return [];
      },
      runScopes: {
        settleDeadOwners: async () => ["scope abc of run r: settled (marker+capture, census ok)"],
      },
    });
    const scopeIndex = order.findIndex((item) => item.startsWith("crash_gc_scopes:"));
    const sweepIndex = order.indexOf("sweep");
    expect(scopeIndex).toBeGreaterThanOrEqual(0);
    expect(scopeIndex).toBeLessThan(sweepIndex);
    expect(order[scopeIndex]).toContain("scopes: scope abc of run r: settled");
  });

  it("the pids tick also runs the scope capture pass, and only once snapshots are armed", async () => {
    vi.useFakeTimers();
    try {
      const root = tempRoot();
      const signals = new EventEmitter() as EventEmitter & Pick<NodeJS.Process, "on" | "off">;
      let ticks = 0;
      const lifecycle = armDaemonLifecycle({
        daemonDir: root,
        logPath: join(root, "daemon.log"),
        signals,
        beginShutdown: async () => {},
        pidsWriter: { refresh: async () => {}, settled: async () => {} },
        scopeCapture: {
          captureTick: async () => {
            ticks += 1;
          },
        },
      });
      vi.advanceTimersByTime(5_000);
      expect(ticks).toBe(0);
      lifecycle.beginPidSnapshots();
      vi.advanceTimersByTime(4_100);
      expect(ticks).toBe(2);
      await lifecycle.finalize();
    } finally {
      vi.useRealTimers();
    }
  });
});
