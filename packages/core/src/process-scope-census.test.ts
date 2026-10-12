import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  ScopeReaper,
  capturedCandidates,
  createLinuxScopeCensusReader,
  createScopeCensusReader,
  darwinLineCarriesMarker,
  environCarriesMarker,
  parseDarwinCensusLine,
  reapScopeMembers,
  type ScopeCensusReader,
  type ScopeCensusResult,
} from "./process-scope-census.js";
import { mintRunScopeMarker } from "./process-scope.js";
import {
  createProcessTableReader,
  descendantProcessRows,
  type CapturedProcess,
  type ProcessTableReader,
  type ProcessTableRow,
} from "./process-table.js";
import {
  createAsyncProcessIdentityReader,
  type AsyncProcessIdentityReader,
  type ProcessIdentity,
} from "./process-identity.js";

const A = mintRunScopeMarker();
const B = mintRunScopeMarker();

/**
 * Deterministic fake kernel: processes carry a marker and a birth token; the
 * census and identity readers answer from it; signals are recorded and
 * SIGKILL (or a cooperative TERM when `coopLethal`) removes a process.
 */
function fakeWorld(opts: {
  procs: Array<{ pid: number; marker: string; token?: string }>;
  immortal?: number[];
  coopLethal?: boolean;
  identityUnreadable?: number[];
  membershipUnreadable?: number[];
  censusFailure?: string;
  /** Processes born when the clock passes `at`. */
  forks?: Array<{ at: number; pid: number; marker: string }>;
}) {
  const alive = new Map(
    opts.procs.map((p) => [p.pid, { marker: p.marker, token: `linux:${p.token ?? p.pid}` }]),
  );
  const immortal = new Set(opts.immortal ?? []);
  const identityUnreadable = new Set(opts.identityUnreadable ?? []);
  const membershipUnreadable = new Set(opts.membershipUnreadable ?? []);
  const forks = [...(opts.forks ?? [])];
  const signals: Array<{ pid: number; signal: string }> = [];
  let t = 0;
  let censuses = 0;
  const census: ScopeCensusReader = {
    async census(markers): Promise<ScopeCensusResult> {
      censuses += 1;
      if (opts.censusFailure) return { status: "failed", reason: opts.censusFailure };
      const members = new Map<string, number[]>();
      for (const marker of markers) {
        members.set(
          marker,
          [...alive].filter(([, p]) => p.marker === marker).map(([pid]) => pid),
        );
      }
      return { status: "ok", members, unreadable: 0 };
    },
    async confirm(pid, marker) {
      if (membershipUnreadable.has(pid)) return null;
      const proc = alive.get(pid);
      return proc ? proc.marker === marker : false;
    },
  };
  const identity: AsyncProcessIdentityReader = {
    async read(pid): Promise<ProcessIdentity> {
      if (identityUnreadable.has(pid))
        return { status: "unknown", pid, platform: "linux", reason: "permission_denied" };
      const proc = alive.get(pid);
      if (!proc) return { status: "missing", pid, platform: "linux" };
      return {
        status: "known",
        pid,
        platform: "linux",
        source: "procfs_stat",
        startToken: proc.token,
        processGroupId: pid,
      };
    },
  };
  return {
    census,
    identity,
    signals,
    signal: (pid: number, signal: NodeJS.Signals) => {
      signals.push({ pid, signal });
      if (!alive.has(pid)) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      const lethal = signal === "SIGKILL" || (opts.coopLethal && signal === "SIGTERM");
      if (lethal && !immortal.has(pid)) alive.delete(pid);
    },
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      for (const fork of forks.splice(0)) {
        if (fork.at <= t) alive.set(fork.pid, { marker: fork.marker, token: `linux:${fork.pid}` });
        else forks.push(fork);
      }
    },
    isAlive: (pid: number) => alive.has(pid),
    censuses: () => censuses,
  };
}

function reapWith(world: ReturnType<typeof fakeWorld>, marker: string, extra = {}) {
  return new ScopeReaper().reap({
    marker,
    census: world.census,
    identity: world.identity,
    signal: world.signal,
    now: world.now,
    sleep: world.sleep,
    graceMs: 1_000,
    deadlineMs: 3_000,
    probeIntervalMs: 250,
    excludePids: [1, 4242],
    platform: "linux",
    ...extra,
  });
}

describe("census line matchers", () => {
  it("extracts the pid and matches only a whole NAME=1 token in a ps -E line", () => {
    const line = `  4711 /bin/sleep 30 PATH=/usr/bin ${A}=1 HOME=/x`;
    expect(parseDarwinCensusLine(line, [A])).toBe(4711);
    expect(darwinLineCarriesMarker(line, A)).toBe(true);
    expect(darwinLineCarriesMarker(line, B)).toBe(false);
    expect(darwinLineCarriesMarker(`4711 x ${A}=10 y`, A)).toBe(false);
    expect(darwinLineCarriesMarker(`4711 x X${A}=1 y`, A)).toBe(false);
    expect(darwinLineCarriesMarker(`4711 ${A}=1`, A)).toBe(true);
    expect(parseDarwinCensusLine("garbage", [A])).toBeNull();
  });

  it("matches the exact NUL-delimited environ entry only", () => {
    expect(environCarriesMarker(`PATH=/usr/bin\0${A}=1\0HOME=/x\0`, A)).toBe(true);
    expect(environCarriesMarker(`${A}=10\0`, A)).toBe(false);
    expect(environCarriesMarker(`X${A}=1\0`, A)).toBe(false);
    expect(environCarriesMarker(``, A)).toBe(false);
  });

  it("linux census reads every numeric /proc entry with the exact entry match and counts unreadable ones", async () => {
    const files = new Map<string, string>([
      [`/proc/10/environ`, `${A}=1\0PATH=/x\0`],
      [`/proc/11/environ`, `${B}=1\0`],
      [`/proc/12/environ`, `${A}=1`],
    ]);
    const reader = createLinuxScopeCensusReader({
      listProc: async () => ["1", "10", "11", "12", "13", "self", "cpuinfo"],
      readTextFile: async (path) => {
        if (path === "/proc/1/environ")
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        if (path === "/proc/13/environ") throw Object.assign(new Error("gone"), { code: "ENOENT" });
        const text = files.get(path);
        if (text === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" });
        return text;
      },
    });
    const result = await reader.census([A, B]);
    expect(result).toEqual({
      status: "ok",
      members: new Map([
        [A, [10, 12]],
        [B, [11]],
      ]),
      unreadable: 1,
    });
    expect(await reader.confirm(10, A)).toBe(true);
    expect(await reader.confirm(11, A)).toBe(false);
    expect(await reader.confirm(13, A)).toBe(false);
    expect(await reader.confirm(1, A)).toBeNull();
  });
});

describe("reapScopeMembers (fake kernel)", () => {
  it("ends every member on the cooperative signal and settles with their birth tokens", async () => {
    const world = fakeWorld({
      procs: [
        { pid: 100, marker: A, token: "7" },
        { pid: 200, marker: A, token: "8" },
      ],
      coopLethal: true,
    });
    const outcome = await reapWith(world, A);
    expect(outcome.settled).toBe(true);
    expect(outcome.census).toBe("ok");
    expect(outcome.coverage).toBe("marker");
    expect(outcome.ended).toEqual([
      { pid: 100, startToken: "linux:7" },
      { pid: 200, startToken: "linux:8" },
    ]);
    expect(outcome.survivors).toEqual([]);
    expect(world.signals.every((s) => s.signal === "SIGTERM")).toBe(true);
  });

  it("escalates to SIGKILL after the grace and then proves the member gone", async () => {
    const world = fakeWorld({ procs: [{ pid: 100, marker: A }] });
    const outcome = await reapWith(world, A);
    expect(outcome.settled).toBe(true);
    expect(outcome.ended.map((m) => m.pid)).toEqual([100]);
    expect(world.signals.map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("reports an immortal member as a SURVIVOR instead of declaring the scope clean", async () => {
    const world = fakeWorld({ procs: [{ pid: 100, marker: A }], immortal: [100] });
    const outcome = await reapWith(world, A);
    expect(outcome.settled).toBe(false);
    expect(outcome.survivors).toEqual([{ pid: 100, startToken: "linux:100" }]);
    expect(outcome.ended).toEqual([]);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(3_000);
  });

  it("never signals a member whose identity is unreadable and reports it separately", async () => {
    const world = fakeWorld({
      procs: [
        { pid: 100, marker: A },
        { pid: 101, marker: A },
      ],
      identityUnreadable: [101],
      coopLethal: true,
    });
    const outcome = await reapWith(world, A);
    expect(outcome.settled).toBe(false);
    expect(outcome.unreadable).toEqual([{ pid: 101, reason: "identity_permission_denied" }]);
    expect(outcome.ended.map((m) => m.pid)).toEqual([100]);
    expect(world.signals.some((s) => s.pid === 101)).toBe(false);
  });

  it("never signals a member whose membership cannot be re-read before the signal", async () => {
    const world = fakeWorld({ procs: [{ pid: 100, marker: A }], membershipUnreadable: [100] });
    const outcome = await reapWith(world, A);
    expect(outcome.unreadable).toEqual([{ pid: 100, reason: "membership_unreadable" }]);
    expect(world.signals).toEqual([]);
    expect(outcome.settled).toBe(false);
  });

  it("a census failure is UNKNOWN: nothing is signalled and the scope is not settled", async () => {
    const world = fakeWorld({ procs: [{ pid: 100, marker: A }], censusFailure: "ps exceeded" });
    const outcome = await reapWith(world, A);
    expect(outcome.census).toBe("failed");
    expect(outcome.censusFailure).toBe("ps exceeded");
    expect(outcome.settled).toBe(false);
    expect(world.signals).toEqual([]);
    expect(world.isAlive(100)).toBe(true);
  });

  it("an empty census of a healthy table settles cleanly ('already gone' is not 'ended')", async () => {
    const world = fakeWorld({ procs: [{ pid: 300, marker: B }] });
    const outcome = await reapWith(world, A);
    expect(outcome).toMatchObject({ settled: true, ended: [], survivors: [], unreadable: [] });
    expect(world.signals).toEqual([]);
  });

  it("catches a member that forked during the grace through the bounded rescan", async () => {
    const world = fakeWorld({
      procs: [{ pid: 100, marker: A }],
      forks: [{ at: 500, pid: 150, marker: A }],
    });
    const outcome = await reapWith(world, A);
    expect(outcome.settled).toBe(true);
    expect(outcome.ended.map((m) => m.pid).sort()).toEqual([100, 150]);
    expect(world.isAlive(150)).toBe(false);
  });

  it("spares a concurrent scope's members and the excluded pids", async () => {
    const world = fakeWorld({
      procs: [
        { pid: 100, marker: A },
        { pid: 300, marker: B },
        { pid: 1, marker: A },
        { pid: 4242, marker: A },
      ],
      coopLethal: true,
    });
    const outcome = await reapWith(world, A);
    expect(outcome.ended.map((m) => m.pid)).toEqual([100]);
    expect(world.isAlive(300)).toBe(true);
    expect(world.isAlive(1)).toBe(true);
    expect(world.isAlive(4242)).toBe(true);
    expect(world.signals.map((s) => s.pid)).toEqual([100]);
    // The other scope is reachable through its own marker.
    const other = await reapWith(world, B);
    expect(other.ended.map((m) => m.pid)).toEqual([300]);
  });

  it("coalesces concurrent reaps of the same marker onto one ladder and one census", async () => {
    const world = fakeWorld({ procs: [{ pid: 100, marker: A }], coopLethal: true });
    const reaper = new ScopeReaper();
    const opts = {
      marker: A,
      census: world.census,
      identity: world.identity,
      signal: world.signal,
      now: world.now,
      sleep: world.sleep,
      graceMs: 1_000,
      probeIntervalMs: 250,
      platform: "linux",
    };
    const [one, two] = await Promise.all([reaper.reap(opts), reaper.reap(opts)]);
    expect(one).toBe(two);
    expect(world.signals.filter((s) => s.pid === 100 && s.signal === "SIGTERM")).toHaveLength(1);
    // A later request after settlement starts a fresh ladder.
    const three = await reaper.reap(opts);
    expect(three).not.toBe(one);
  });

  it("refuses a name outside the grammar before touching any process", async () => {
    await expect(reapScopeMembers({ marker: "NOT_A_MARKER", platform: "linux" })).rejects.toThrow(
      /grammar/,
    );
  });

  it("win32 has no environment census: coverage tree_only, disclosed, never a failure", async () => {
    const outcome = await new ScopeReaper().reap({ marker: A, platform: "win32" });
    expect(outcome).toMatchObject({
      coverage: "tree_only",
      census: "unsupported",
      settled: false,
      ended: [],
      survivors: [],
      unreadable: [],
    });
    expect(createScopeCensusReader("win32")).toBeNull();
  });
});

/**
 * Fake table for the RECORDED sources: processes whose environment is
 * invisible (platform binaries on macOS) and are reachable only by the
 * (pid, pgid, birth) rows the daemon captured. The marker census sees nothing.
 */
function tableWorld(opts: {
  rows: ProcessTableRow[];
  immortal?: number[];
  coopLethal?: boolean;
  unreadable?: number[];
  snapshotFails?: boolean;
}) {
  const rows = new Map(opts.rows.map((row) => [row.pid, { ...row }]));
  const immortal = new Set(opts.immortal ?? []);
  const unreadable = new Set(opts.unreadable ?? []);
  const signals: Array<{ pid: number; signal: string }> = [];
  let t = 0;
  const table: ProcessTableReader = {
    async snapshot() {
      return opts.snapshotFails ? null : [...rows.values()];
    },
    async row(pid) {
      if (unreadable.has(pid)) return "unreadable";
      return rows.get(pid) ?? null;
    },
  };
  const emptyCensus: ScopeCensusReader = {
    async census(markers) {
      return { status: "ok", members: new Map(markers.map((m) => [m, []])), unreadable: 0 };
    },
    async confirm() {
      return false;
    },
  };
  return {
    table,
    census: emptyCensus,
    signals,
    signal: (pid: number, signal: NodeJS.Signals) => {
      signals.push({ pid, signal });
      if (!rows.has(pid)) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      const lethal = signal === "SIGKILL" || (opts.coopLethal && signal === "SIGTERM");
      if (lethal && !immortal.has(pid)) rows.delete(pid);
    },
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    isAlive: (pid: number) => rows.has(pid),
  };
}

const T0 = "Mon Oct 12 14:00:00 2026";
const T1 = "Mon Oct 12 14:00:05 2026";
const T2 = "Mon Oct 12 14:00:09 2026";
const EARLIER = "Mon Oct 12 13:00:00 2026";

function reapCaptured(
  world: ReturnType<typeof tableWorld>,
  captured: CapturedProcess[],
  scopeStart: string | null = T0,
) {
  return new ScopeReaper().reap({
    marker: A,
    census: world.census,
    table: world.table,
    captured,
    scopeStart,
    signal: world.signal,
    now: world.now,
    sleep: world.sleep,
    graceMs: 1_000,
    deadlineMs: 3_000,
    probeIntervalMs: 250,
    excludePids: [1, 4242],
    platform: "darwin",
  });
}

describe("capturedCandidates (DIRECTIVE 1 rule 2, pure)", () => {
  // Harness root 100 (own group), its setsid shell 200 (pgid 200), the shell's
  // child 210 (pgid 200). Captured while the chain was intact.
  const captured: CapturedProcess[] = [
    { pid: 100, pgid: 100, birth: T0 },
    { pid: 200, pgid: 200, birth: T1 },
    { pid: 210, pgid: 200, birth: T1 },
  ];

  it("ends a leaderless group member by recorded group: the orphaned child of a dead shell", () => {
    // The shell (200) was killed by the model; 210 was reparented to pid 1 and
    // kept pgid 200. Nothing owns pid 200 now.
    const rows: ProcessTableRow[] = [{ pid: 210, ppid: 1, pgid: 200, birth: T1 }];
    const found = capturedCandidates(captured, rows, T0);
    expect([...found.candidates]).toEqual([[210, T1]]);
    expect(found.reusedGroups).toEqual([]);
  });

  it("includes a fork born inside a recorded group after the capture", () => {
    const rows: ProcessTableRow[] = [
      { pid: 210, ppid: 1, pgid: 200, birth: T1 },
      { pid: 230, ppid: 210, pgid: 200, birth: T2 }, // never individually captured
    ];
    const found = capturedCandidates(captured, rows, T0);
    expect([...found.candidates.keys()].sort()).toEqual([210, 230]);
  });

  it("skips a group whose id is now owned by a process with another birth (pid reused as leader)", () => {
    const rows: ProcessTableRow[] = [
      { pid: 200, ppid: 1, pgid: 200, birth: T2 }, // a stranger reusing pid 200
      { pid: 210, ppid: 1, pgid: 200, birth: T1 },
    ];
    const found = capturedCandidates(captured, rows, T0);
    expect(found.candidates.has(200)).toBe(false);
    expect(found.reusedGroups).toEqual([200]);
    // 210 is still individually captured with its own birth, so it is ended
    // on its own evidence — never through the group.
    expect([...found.candidates]).toEqual([[210, T1]]);
  });

  it("keeps a group whose live leader still has the recorded birth", () => {
    const rows: ProcessTableRow[] = [
      { pid: 200, ppid: 100, pgid: 200, birth: T1 },
      { pid: 210, ppid: 200, pgid: 200, birth: T1 },
    ];
    const found = capturedCandidates(captured, rows, T0);
    expect([...found.candidates.keys()].sort()).toEqual([200, 210]);
    expect(found.reusedGroups).toEqual([]);
  });

  it("skips a group with a member born before the scope, and every group without a birth floor", () => {
    const rows: ProcessTableRow[] = [
      { pid: 210, ppid: 1, pgid: 200, birth: T1 },
      { pid: 7, ppid: 1, pgid: 200, birth: EARLIER }, // predates the run: not ours
    ];
    expect(capturedCandidates(captured, rows, T0).reusedGroups).toEqual([200]);
    // 210 keeps its individual evidence either way.
    expect(capturedCandidates(captured, rows, T0).candidates.has(210)).toBe(true);
    const noFloor = capturedCandidates(
      captured,
      [{ pid: 210, ppid: 1, pgid: 200, birth: T1 }],
      null,
    );
    expect(noFloor.reusedGroups).toEqual([200]);
    expect([...noFloor.candidates]).toEqual([[210, T1]]);
  });

  it("drops an individually captured pid whose birth changed (reused) and a group that emptied", () => {
    const rows: ProcessTableRow[] = [{ pid: 210, ppid: 1, pgid: 999, birth: T2 }];
    const found = capturedCandidates(captured, rows, T0);
    expect(found.candidates.size).toBe(0);
    expect(found.reusedGroups).toEqual([]);
  });
});

describe("reapScopeMembers with recorded sources (fake table)", () => {
  const captured: CapturedProcess[] = [
    { pid: 100, pgid: 100, birth: T0 },
    { pid: 200, pgid: 200, birth: T1 },
  ];

  it("ends an env-invisible orphan through its recorded group and reports marker+capture coverage", async () => {
    const world = tableWorld({
      rows: [{ pid: 210, ppid: 1, pgid: 200, birth: T1 }],
      coopLethal: true,
    });
    const outcome = await reapCaptured(world, captured);
    expect(outcome.coverage).toBe("marker+capture");
    expect(outcome.settled).toBe(true);
    expect(outcome.ended).toEqual([{ pid: 210, startToken: `ps:${T1}` }]);
    expect(world.isAlive(210)).toBe(false);
  });

  it("re-measures the birth immediately before signalling and never signals a reused pid", async () => {
    const world = tableWorld({ rows: [{ pid: 210, ppid: 1, pgid: 200, birth: T1 }] });
    // Swap the pid for a stranger between the snapshot and the signal.
    const snapshot = world.table.snapshot.bind(world.table);
    world.table.snapshot = async () => {
      const rows = await snapshot();
      queueMicrotask(() => {
        world.table.row = async () => ({ pid: 210, ppid: 1, pgid: 210, birth: T2 });
      });
      return rows;
    };
    const outcome = await reapCaptured(world, captured);
    expect(world.signals).toEqual([]);
    expect(outcome.ended).toEqual([]);
    expect(outcome.settled).toBe(true);
  });

  it("escalates a recorded member to SIGKILL and reports an immortal one as a survivor", async () => {
    const world = tableWorld({
      rows: [
        { pid: 210, ppid: 1, pgid: 200, birth: T1 },
        { pid: 220, ppid: 1, pgid: 200, birth: T1 },
      ],
      immortal: [220],
    });
    const outcome = await reapCaptured(world, captured);
    expect(outcome.ended.map((m) => m.pid)).toEqual([210]);
    expect(outcome.survivors).toEqual([{ pid: 220, startToken: `ps:${T1}` }]);
    expect(outcome.settled).toBe(false);
    expect(world.signals.filter((s) => s.pid === 210).map((s) => s.signal)).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
  });

  it("an unreadable process table is a census failure: nothing is claimed settled", async () => {
    const world = tableWorld({
      rows: [{ pid: 210, ppid: 1, pgid: 200, birth: T1 }],
      snapshotFails: true,
    });
    const outcome = await reapCaptured(world, captured);
    expect(outcome.census).toBe("failed");
    expect(outcome.censusFailure).toBe("process table unreadable");
    expect(outcome.settled).toBe(false);
    expect(world.signals).toEqual([]);
  });

  it("discloses a reused group and leaves its members alone", async () => {
    const world = tableWorld({
      rows: [
        { pid: 200, ppid: 1, pgid: 200, birth: T2 },
        { pid: 300, ppid: 200, pgid: 200, birth: T2 },
      ],
    });
    const outcome = await reapCaptured(world, captured);
    expect(outcome.reusedGroups).toEqual([200]);
    expect(world.signals).toEqual([]);
    expect(world.isAlive(300)).toBe(true);
  });

  it("without captured rows coverage stays marker-only", async () => {
    const world = tableWorld({ rows: [] });
    const outcome = await new ScopeReaper().reap({
      marker: A,
      census: world.census,
      signal: world.signal,
      platform: "linux",
    });
    expect(outcome.coverage).toBe("marker");
    expect(outcome.settled).toBe(true);
  });
});

const posix = process.platform === "darwin" || process.platform === "linux";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Start a long-lived grandchild whose parent exits at once, so the grandchild
 * is reparented to pid 1 in a leaderless process group — the #449 orphan shape.
 * The grandchild is a managed-`node` process on purpose: its marker is readable
 * on every supported host (Linux `/proc/<pid>/environ`, and macOS `ps -E`,
 * which — unlike for an Apple *platform* binary — exposes a non-platform
 * binary's environment under SIP). A platform-binary orphan on macOS is the
 * disclosed residual exercised by the limitation test below.
 */
function orphanNode(marker: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const {spawn}=require('node:child_process');" +
          "const c=spawn(process.execPath,['-e','setTimeout(()=>{},600000)'],{detached:true,stdio:'ignore',env:process.env});" +
          "c.unref();process.stdout.write(String(c.pid));",
      ],
      {
        env: { ...process.env, [marker]: "1" },
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.once("error", reject);
    child.once("close", () => {
      const pid = Number(out.trim());
      Number.isSafeInteger(pid) && pid > 0 ? resolve(pid) : reject(new Error(`no pid: ${out}`));
    });
  });
}

describe.runIf(posix)("reapScopeMembers on real processes", () => {
  it("ends a reparented, leaderless orphan by marker and spares a concurrent scope's orphan", async () => {
    const markerA = mintRunScopeMarker();
    const markerB = mintRunScopeMarker();
    const orphanA = await orphanNode(markerA);
    const orphanB = await orphanNode(markerB);
    try {
      expect(alive(orphanA)).toBe(true);
      expect(alive(orphanB)).toBe(true);
      const census = createScopeCensusReader()!;
      expect(await census.confirm(orphanA, markerA)).toBe(true);
      expect(await census.confirm(orphanA, markerB)).toBe(false);
      const outcome = await reapScopeMembers({ marker: markerA, graceMs: 1_000 });
      expect(outcome.census).toBe("ok");
      expect(outcome.settled).toBe(true);
      expect(outcome.ended.map((m) => m.pid)).toEqual([orphanA]);
      expect(alive(orphanA)).toBe(false);
      expect(alive(orphanB)).toBe(true);
      const other = await reapScopeMembers({ marker: markerB, graceMs: 1_000 });
      expect(other.ended.map((m) => m.pid)).toEqual([orphanB]);
      expect(alive(orphanB)).toBe(false);
      expect(await census.confirm(orphanA, markerA)).toBe(false);
    } finally {
      for (const pid of [orphanA, orphanB]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }, 20_000);

  it("discloses the darwin census as restricted and the full census on linux (both directions)", async () => {
    const marker = mintRunScopeMarker();
    const orphan = await orphanNode(marker);
    try {
      const outcome = await reapScopeMembers({ marker, graceMs: 1_000 });
      expect(outcome.ended.map((m) => m.pid)).toEqual([orphan]);
      expect(outcome.restricted).toBe(process.platform === "darwin");
    } finally {
      try {
        process.kill(orphan, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 20_000);

  it("pins the macOS platform-binary census limit: hidden on darwin (SIP), visible on linux", async () => {
    const marker = mintRunScopeMarker();
    // An Apple *platform* binary (/bin/sleep) reparented to pid 1: the #449
    // orphan shape. Its environment is withheld by SIP on darwin and readable
    // via /proc on linux. Pinning both directions makes a future macOS change
    // that exposes it fail here, prompting an honest coverage upgrade.
    const orphan = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          "const {spawn}=require('node:child_process');" +
            "const c=spawn('/bin/sleep',['600'],{detached:true,stdio:'ignore',env:process.env});" +
            "c.unref();process.stdout.write(String(c.pid));",
        ],
        {
          env: { ...process.env, [marker]: "1" },
          detached: true,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString()));
      child.once("error", reject);
      child.once("close", () => resolve(Number(out.trim())));
    });
    try {
      const census = createScopeCensusReader()!;
      const confirmed = await census.confirm(orphan, marker);
      if (process.platform === "linux") expect(confirmed).toBe(true);
      else expect(confirmed).toBe(false); // darwin: hidden by SIP — disclosed residual
    } finally {
      try {
        process.kill(orphan, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 20_000);

  it("ends a platform-binary background child (env invisible on darwin) through the recorded group (DIRECTIVE 1 item 5)", async () => {
    const marker = mintRunScopeMarker();
    // The incident shape with a platform binary: a detached shell starts a
    // background /bin/sleep and exits. The sleep keeps the shell's pgid and
    // is reparented to pid 1; on darwin its environment is hidden by SIP, so
    // only the rows the daemon captured while the shell was alive reach it.
    const shell = spawn("/bin/sh", ["-c", "/bin/sleep 600 & /bin/sleep 0.5"], {
      env: { ...process.env, [marker]: "1" },
      detached: true,
      stdio: "ignore",
    });
    const shellPid = shell.pid!;
    const table = createProcessTableReader();
    // The daemon's capture tick, while the chain is intact.
    let captured: CapturedProcess[] = [];
    for (let i = 0; i < 20 && captured.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const rows = (await table.snapshot()) ?? [];
      captured = descendantProcessRows(shellPid, rows).map((r) => ({
        pid: r.pid,
        pgid: r.pgid,
        birth: r.birth,
      }));
    }
    const orphan = captured.find((c) => c.pid !== shellPid && c.pgid === shellPid);
    try {
      expect(orphan).toBeDefined();
      const scopeStart = captured.find((c) => c.pid === shellPid)!.birth;
      await new Promise<void>((resolve) => shell.once("close", () => resolve()));
      expect(alive(orphan!.pid)).toBe(true);
      const outcome = await reapScopeMembers({ marker, captured, scopeStart, graceMs: 1_000 });
      expect(outcome.coverage).toBe("marker+capture");
      expect(outcome.census).toBe("ok");
      expect(outcome.settled).toBe(true);
      expect(outcome.ended.map((m) => m.pid)).toContain(orphan!.pid);
      expect(alive(orphan!.pid)).toBe(false);
    } finally {
      for (const pid of [shellPid, orphan?.pid ?? 0]) {
        try {
          if (pid) process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }, 20_000);

  it("reads identity asynchronously with the synchronous reader's exact vocabulary", async () => {
    const reader = createAsyncProcessIdentityReader();
    const self = await reader.read(process.pid);
    expect(self.status).toBe("known");
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const pid = child.pid!;
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    expect((await reader.read(pid)).status).toBe("missing");
    expect((await reader.read(0)).status).toBe("unknown");
  });
});

describe("createAsyncProcessIdentityReader seams", () => {
  it("maps the darwin helper's exits like the synchronous service", async () => {
    const at = (status: number, stdout = "") =>
      createAsyncProcessIdentityReader({
        platform: "darwin",
        darwinHelperPath: "/helper",
        runDarwinHelper: async () => ({ status, stdout, stderr: "" }),
      }).read(77);
    expect((await at(3)).status).toBe("missing");
    expect(await at(4)).toMatchObject({ status: "unknown", reason: "permission_denied" });
    expect(await at(9)).toMatchObject({ status: "unknown", reason: "helper_failed" });
    expect(await at(0, "claudexor-process-identity-v2\t77\t77\t12\t000001\n")).toMatchObject({
      status: "known",
      startToken: "darwin:12:000001",
      processGroupId: 77,
    });
    const noHelper = createAsyncProcessIdentityReader({
      platform: "darwin",
      darwinHelperPath: null,
    });
    expect(await noHelper.read(77)).toMatchObject({
      status: "unknown",
      reason: "helper_unavailable",
    });
  });

  it("stays unsupported on win32 and reads /proc on linux", async () => {
    expect(await createAsyncProcessIdentityReader({ platform: "win32" }).read(5)).toMatchObject({
      status: "unknown",
      reason: "unsupported_platform",
    });
    const linux = createAsyncProcessIdentityReader({
      platform: "linux",
      readTextFile: async (path) => {
        if (path === "/proc/5/stat") throw Object.assign(new Error("x"), { code: "ENOENT" });
        if (path === "/proc/6/stat") throw Object.assign(new Error("x"), { code: "EACCES" });
        return "7 (a) S 1 7 7 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 4242 0 0 0\n";
      },
    });
    expect((await linux.read(5)).status).toBe("missing");
    expect(await linux.read(6)).toMatchObject({ status: "unknown", reason: "permission_denied" });
    expect(await linux.read(7)).toMatchObject({ status: "known", startToken: "linux:4242" });
  });
});
