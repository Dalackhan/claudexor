import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  ScopeReaper,
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
