import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  mintRunScopeMarker,
  type KnownProcessIdentity,
  type LiveChildProcess,
  type ProcessGroupHandle,
  type ProcessIdentity,
  type ProcessTableReader,
  type ProcessTableRow,
  type ScopeReapOptions,
  type ScopeReapOutcome,
} from "@claudexor/core";
import { DaemonRunScopeIndex, RUN_SCOPE_INDEX_FILE } from "./run-scope-index.js";
import { spawnProcess } from "@claudexor/core";
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
    completeness: "complete",
    completenessReason: null,
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

/** A registry root as `liveChildProcesses()` reports it: pid, marker and the spawn-time handle. */
function fakeRoot(pid: number, scopeMarker: string): LiveChildProcess {
  const leader = known(pid, String(pid));
  return {
    pid,
    cmd: "harness",
    scopeMarker,
    processGroup: { schemaVersion: 1, pgid: pid, leader } as unknown as ProcessGroupHandle,
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
      identity: fakeIdentity({ 100: known(100, "100") }),
      roots: () => [fakeRoot(100, marker)],
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

  it("capture revalidates the root's spawn-time identity: a reused root pid captures nothing (item 7)", async () => {
    const root = tempRoot();
    const rows: ProcessTableRow[] = [
      { pid: 100, ppid: 1, pgid: 100, birth: T1 }, // a stranger now owns pid 100
      { pid: 200, ppid: 100, pgid: 200, birth: T1 },
    ];
    const reused = new DaemonRunScopeIndex({
      path: join(root, RUN_SCOPE_INDEX_FILE),
      owner: async () => known(process.pid, "7"),
      reap: fakeReaper().reap,
      table: fakeTable(rows),
      // The registry handle says birth "100"; the live reading says "999".
      identity: fakeIdentity({ 100: known(100, "999") }),
      roots: () => [fakeRoot(100, marker)],
    });
    const { marker } = await reused.open("run-reused");
    await reused.captureTick();
    expect(reused.list()[0]!.captured).toEqual([]);
    // Unchanged identity: walked as usual.
    const same = new DaemonRunScopeIndex({
      path: join(root, "same.json"),
      owner: async () => known(process.pid, "7"),
      reap: fakeReaper().reap,
      table: fakeTable(rows),
      identity: fakeIdentity({ 100: known(100, "100") }),
      roots: () => [fakeRoot(100, marker2)],
    });
    const { marker: marker2 } = await same.open("run-same");
    await same.captureTick();
    expect(same.list()[0]!.captured.map((c) => c.pid)).toEqual([100, 200]);
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
      identity: fakeIdentity({ 100: known(100, "100") }),
      roots: () => [fakeRoot(100, marker)],
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

  it("start: reaps a dead generation's scopes, spares a live owner's, never touches an unindexed marker, treats a missing file as empty and an unreadable one as unknown (preserved aside)", async () => {
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
            root_groups: [],
            captured: [{ pid: 210, pgid: 200, birth: T1 }],
          },
          {
            marker: liveMarker,
            run_id: "run-live",
            owner: liveDaemon,
            state: "open",
            opened_at: "x",
            scope_start: null,
            root_groups: [],
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
    // Corrupt file: UNKNOWN, not empty — disclosed, preserved aside, index usable.
    const corruptPath = join(root, "corrupt.json");
    writeFileSync(corruptPath, "{not json");
    const disclosures: string[] = [];
    const corrupt = new DaemonRunScopeIndex({
      path: corruptPath,
      reap: reaper.reap,
      table: fakeTable([]),
      roots: () => [],
      log: (message) => disclosures.push(message),
    });
    expect(await corrupt.settleDeadOwners()).toEqual([]);
    expect(disclosures.join("\n")).toMatch(/unreadable .*parse failed.*UNKNOWN/);
    const aside = readdirSync(root).find((name) => name.startsWith("corrupt.json.unreadable-"));
    expect(aside).toBeDefined();
    expect(readFileSync(join(root, aside!), "utf8")).toBe("{not json");
    // The index stays usable: a new run is recorded in a fresh file.
    await corrupt.open("run-after-corrupt");
    expect(JSON.parse(readFileSync(corruptPath, "utf8")).entries).toHaveLength(1);
    // A readable, well-formed file is never moved aside; a missing one is simply empty.
    expect(disclosures).toHaveLength(1);
  });

  it("an entry whose census is unsupported (Windows) is retired after disclosure, never kept forever", async () => {
    const root = tempRoot();
    const path = join(root, RUN_SCOPE_INDEX_FILE);
    const unsupported = settledOutcome({
      coverage: "tree_only",
      census: "unsupported",
      settled: false,
    });
    const index = new DaemonRunScopeIndex({
      path,
      owner: async () => known(process.pid, "7"),
      reap: fakeReaper({}).reap,
      table: fakeTable([]),
      roots: () => [],
    });
    const { marker } = await index.open("run-win");
    const retiring = new DaemonRunScopeIndex({
      path,
      owner: async () => known(process.pid, "7"),
      reap: fakeReaper({ [marker]: unsupported }).reap,
      table: fakeTable([]),
      roots: () => [],
    });
    const outcome = await retiring.settle("run-win", marker);
    expect(outcome.settled).toBe(false);
    expect(readIndex(root).entries).toEqual([]);
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
            root_groups: [],
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Spawn a marked /bin/sh root through the engine's own spawn path; it starts a
 * background /bin/sleep (platform binary: env invisible on darwin) in ITS OWN
 * group and exits within ~100 ms — before any 2 s capture tick could run. */
async function shortRootLeavingSleep(marker: string): Promise<{ sleepPid: number }> {
  let sleepPid = 0;
  for await (const ev of spawnProcess(
    "/bin/sh",
    ["-c", "/bin/sleep 600 & echo sleep:$!; /bin/sleep 0.1"],
    { env: { [marker]: "1" } },
  )) {
    if (ev.type === "stdout" && ev.line.startsWith("sleep:")) sleepPid = Number(ev.line.slice(6));
  }
  return { sleepPid };
}

describe.runIf(process.platform !== "win32")(
  "root group seeded at spawn (fix round 1 item 2)",
  () => {
    it("a short root that exits before the first tick still leaves its group on record, and its background /bin/sleep is ended at the barrier", async () => {
      const root = tempRoot();
      const index = new DaemonRunScopeIndex({ path: join(root, RUN_SCOPE_INDEX_FILE) });
      let sleepPid = 0;
      try {
        const { marker } = await index.open("run-short");
        ({ sleepPid } = await shortRootLeavingSleep(marker));
        expect(sleepPid).toBeGreaterThan(0);
        expect(alive(sleepPid)).toBe(true);
        // No captureTick was ever called: only the spawn-time seed exists.
        const outcome = await index.settle("run-short", marker);
        expect(outcome.ended.map((m) => m.pid)).toContain(sleepPid);
        expect(outcome.settled).toBe(true);
        expect(alive(sleepPid)).toBe(false);
      } finally {
        index.dispose();
        try {
          if (sleepPid) process.kill(sleepPid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, 30_000);

    it("a daemon that crashed before the first tick: the next start settles the seeded group and ends the leftover", async () => {
      const root = tempRoot();
      const path = join(root, RUN_SCOPE_INDEX_FILE);
      const dying = new DaemonRunScopeIndex({ path });
      let sleepPid = 0;
      try {
        const { marker } = await dying.open("run-crashed");
        ({ sleepPid } = await shortRootLeavingSleep(marker));
        // Let the spawn-time seed land on disk, then "crash" (no settle).
        await new Promise((resolve) => setTimeout(resolve, 300));
        dying.dispose();
        const persisted = readIndex(root).entries[0]!;
        expect((persisted["root_groups"] as unknown[]).length).toBe(1);
        expect(persisted["scope_start"]).toBeTruthy();
        expect(alive(sleepPid)).toBe(true);
        // Next daemon life: the previous owner's identity is gone.
        const next = new DaemonRunScopeIndex({ path, identity: fakeIdentity({}), roots: () => [] });
        const actions = await next.settleDeadOwners();
        expect(actions.join("\n")).toMatch(/run-crashed: settled/);
        expect(alive(sleepPid)).toBe(false);
        expect(readIndex(root).entries).toEqual([]);
      } finally {
        dying.dispose();
        try {
          if (sleepPid) process.kill(sleepPid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, 30_000);
  },
);

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
