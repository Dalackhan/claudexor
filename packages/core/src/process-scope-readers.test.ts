import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { mintRunScopeMarker } from "./process-scope.js";
import { reapScopeMembers } from "./process-scope-census.js";
import {
  createDarwinScopeCensusReader,
  parseEtime,
  runPs,
  SCOPE_AGE_SLACK_SECONDS,
  scopeAgeSeconds,
  type PsRunFailure,
  type PsRunner,
  type ScopeCensusReader,
} from "./process-scope-readers.js";

/**
 * A fake `ps`: the `etime` listing (or its failure) and, per pid, the text
 * `ps -E` would print after the pid. A `-p` list prints only the pids it has;
 * a list with no live pid exits 1 like the real one.
 */
function fakePs(table: {
  etime: Record<number, string> | PsRunFailure;
  env: Record<number, string>;
  gate?: () => Promise<void>;
}) {
  const calls: string[][] = [];
  const ps: PsRunner = async (args, onLine) => {
    calls.push(args);
    await table.gate?.();
    if (args[0] === "-A" && args[2] === "pid=,etime=") {
      if ("status" in table.etime) return table.etime;
      for (const [pid, etime] of Object.entries(table.etime)) onLine(`${pid.padStart(6)} ${etime}`);
      return null;
    }
    const at = args.indexOf("-p");
    const pids =
      at === -1 ? Object.keys(table.env).map(Number) : args[at + 1]!.split(",").map(Number);
    let rows = 0;
    for (const pid of pids) {
      const line = table.env[pid];
      if (line === undefined) continue;
      onLine(`${pid} ${line}`);
      rows += 1;
    }
    return at !== -1 && rows === 0 ? { status: "failed", reason: "ps exited 1" } : null;
  };
  return { ps, calls };
}

const M = mintRunScopeMarker();
const carrying = `node ${M}=1 HOME=/x`;

describe("parseEtime", () => {
  it("parses the three ps etime shapes and rejects anything else", () => {
    expect(parseEtime("05:07")).toBe(307);
    expect(parseEtime("01:02:03")).toBe(3_723);
    expect(parseEtime("2-01:02:03")).toBe(2 * 86_400 + 3_723);
    expect(parseEtime(" 00:00 ")).toBe(0);
    for (const bad of ["", "x", "1:2:3:4", "12", "1-2", "??", "00:0"]) {
      expect(parseEtime(bad)).toBeNull();
    }
  });
});

describe("scopeAgeSeconds", () => {
  it("is the seconds since the ISO opening time against the given clock; unknown or unparseable → undefined (both directions)", () => {
    const now = Date.parse("2026-10-12T17:00:10.500Z");
    expect(scopeAgeSeconds("2026-10-12T17:00:00.000Z", now)).toBe(10.5);
    expect(scopeAgeSeconds("2026-10-12T17:00:20.000Z", now)).toBe(0); // clock stepped back: never negative
    expect(scopeAgeSeconds(null, now)).toBeUndefined();
    expect(scopeAgeSeconds(undefined, now)).toBeUndefined();
    expect(scopeAgeSeconds("", now)).toBeUndefined();
    expect(scopeAgeSeconds("not a time", now)).toBeUndefined();
    expect(scopeAgeSeconds(new Date(Date.now() - 3_000).toISOString())).toBeGreaterThanOrEqual(2.9);
  });
});

describe("darwin census with a known scope age", () => {
  it("reads environments only of processes no older than the scope plus slack; unparseable rows are read; older ones never (both directions)", async () => {
    const age = 60;
    const fake = fakePs({
      etime: {
        10: "3-00:00:00", // old: cannot carry a marker minted 60 s ago
        20: "00:03", // young
        30: "??", // unparseable: read
        40: `01:${String(age + SCOPE_AGE_SLACK_SECONDS - 60).padStart(2, "0")}`, // exactly age+slack
        50: `01:${String(age + SCOPE_AGE_SLACK_SECONDS - 60 + 1).padStart(2, "0")}`, // one second older
      },
      env: { 10: carrying, 20: carrying, 30: carrying, 40: carrying, 50: carrying },
    });
    const reader = createDarwinScopeCensusReader({ ps: fake.ps });
    const result = await reader.census([M], age);
    expect(result).toEqual({ status: "ok", members: new Map([[M, [20, 30, 40]]]), unreadable: 0 });
    expect(fake.calls).toEqual([
      ["-A", "-o", "pid=,etime="],
      ["-E", "-ww", "-o", "pid=,command=", "-p", "20,30,40"],
    ]);
  });

  it("no age → the full census, no etime listing", async () => {
    const fake = fakePs({ etime: { 10: "3-00:00:00" }, env: { 10: carrying } });
    const reader = createDarwinScopeCensusReader({ ps: fake.ps });
    const result = await reader.census([M]);
    expect(result).toEqual({ status: "ok", members: new Map([[M, [10]]]), unreadable: 0 });
    expect(fake.calls).toEqual([["-E", "-ww", "-A", "-o", "pid=,command="]]);
  });

  it("a failed etime listing → the full census (unknown ages read everything)", async () => {
    const fake = fakePs({
      etime: { status: "failed", reason: "ps exceeded 10000ms" },
      env: { 10: carrying },
    });
    const reader = createDarwinScopeCensusReader({ ps: fake.ps });
    const result = await reader.census([M], 1);
    expect(result).toEqual({ status: "ok", members: new Map([[M, [10]]]), unreadable: 0 });
    expect(fake.calls).toEqual([
      ["-A", "-o", "pid=,etime="],
      ["-E", "-ww", "-A", "-o", "pid=,command="],
    ]);
  });

  it("no candidate → an ok census with no members and no environment read at all", async () => {
    const fake = fakePs({ etime: { 10: "3-00:00:00" }, env: { 10: carrying } });
    const reader = createDarwinScopeCensusReader({ ps: fake.ps });
    expect(await reader.census([M], 1)).toEqual({
      status: "ok",
      members: new Map([[M, []]]),
      unreadable: 0,
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("every candidate vanished between the two reads (`ps -p` exits 1, no row) → ok and empty, not a failed census", async () => {
    const fake = fakePs({ etime: { 20: "00:01" }, env: {} });
    const reader = createDarwinScopeCensusReader({ ps: fake.ps });
    expect(await reader.census([M], 1)).toEqual({
      status: "ok",
      members: new Map([[M, []]]),
      unreadable: 0,
    });
    // A genuine failure of the environment read is still a failed census.
    const broken = fakePs({ etime: { 20: "00:01" }, env: { 20: carrying } });
    const failing: PsRunner = async (args, onLine) =>
      args.includes("-E")
        ? { status: "failed", reason: "ps exceeded 10000ms" }
        : broken.ps(args, onLine);
    expect(await createDarwinScopeCensusReader({ ps: failing }).census([M], 1)).toEqual({
      status: "failed",
      reason: "ps exceeded 10000ms",
    });
  });

  it("coalesces concurrent callers under the LARGEST age (a superset); any caller without an age means the full census", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let gated = true;
    const fake = fakePs({
      etime: { 10: "3-00:00:00", 20: "00:50", 30: "00:02" },
      env: { 10: carrying, 20: carrying, 30: carrying },
      gate: () => (gated ? gate : Promise.resolve()),
    });
    const reader = createDarwinScopeCensusReader({ ps: fake.ps });
    const first = reader.census([M], 10); // in flight (gated inside ps)
    const second = reader.census([M], 10); // queued for the NEXT scan…
    const third = reader.census([M], 100); // …which takes the largest age
    gated = false;
    release();
    expect(await first).toEqual({ status: "ok", members: new Map([[M, [30]]]), unreadable: 0 });
    expect(await second).toEqual({
      status: "ok",
      members: new Map([[M, [20, 30]]]),
      unreadable: 0,
    });
    expect(await third).toEqual({ status: "ok", members: new Map([[M, [20, 30]]]), unreadable: 0 });
    expect(fake.calls.filter((c) => c.includes("-p")).map((c) => c[c.indexOf("-p") + 1])).toEqual([
      "30", // first scan: age 10 (+5 s slack) admits only the 2 s old process
      "20,30", // second scan: limit 100 covers the 50 s old one too
    ]);
    // One caller without an age in a batch → that batch is the full census
    // (the batch forms behind a scan in flight: `fourth` starts synchronously,
    // `fifth` and `sixth` queue together for the next scan).
    const fourth = reader.census([M], 1);
    const fifth = reader.census([M]);
    const sixth = reader.census([M], 1);
    expect(await fourth).toEqual({ status: "ok", members: new Map([[M, [30]]]), unreadable: 0 });
    expect(await fifth).toEqual({
      status: "ok",
      members: new Map([[M, [10, 20, 30]]]),
      unreadable: 0,
    });
    expect(await sixth).toEqual({
      status: "ok",
      members: new Map([[M, [10, 20, 30]]]),
      unreadable: 0,
    });
    expect(fake.calls.at(-1)).toEqual(["-E", "-ww", "-A", "-o", "pid=,command="]);
  });
});

describe("reapScopeMembers hands the census the scope's age", () => {
  const recording = () => {
    const ages: Array<number | undefined> = [];
    const census: ScopeCensusReader = {
      async census(markers, maxAgeSeconds) {
        ages.push(maxAgeSeconds);
        return { status: "ok", members: new Map(markers.map((m) => [m, []])), unreadable: 0 };
      },
      async confirm() {
        return false;
      },
    };
    return { ages, census };
  };
  it("from scopeStartAt against the wall clock; none without an opening time (both directions)", async () => {
    const aged = recording();
    await reapScopeMembers({
      marker: M,
      census: aged.census,
      scopeStartAt: new Date(Date.now() - 3_000).toISOString(),
    });
    expect(aged.ages).toHaveLength(1);
    expect(aged.ages[0]).toBeGreaterThanOrEqual(2.5);
    expect(aged.ages[0]).toBeLessThan(30);
    const unknown = recording();
    await reapScopeMembers({ marker: M, census: unknown.census });
    expect(unknown.ages).toEqual([undefined]);
    const unparseable = recording();
    await reapScopeMembers({ marker: M, census: unparseable.census, scopeStartAt: "not a time" });
    expect(unparseable.ages).toEqual([undefined]);
  });
});

describe.runIf(process.platform === "darwin")("darwin census on real processes", () => {
  it("finds a marker child spawned after the scope opened through the filtered census and never reads a pre-existing process", async () => {
    const marker = mintRunScopeMarker();
    const openedAt = Date.now();
    const child = spawn(
      process.execPath,
      ["-e", "process.stdout.write(String(process.pid)); setTimeout(() => {}, 30000)"],
      { env: { ...process.env, [marker]: "1" }, stdio: ["ignore", "pipe", "ignore"] },
    );
    const pid = await new Promise<number>((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const n = Number(out.trim());
        if (Number.isSafeInteger(n) && n > 0) resolve(n);
      });
      child.once("error", reject);
    });
    try {
      const calls: string[][] = [];
      const reader = createDarwinScopeCensusReader({
        ps: (args, onLine) => {
          calls.push(args);
          return runPs(args, onLine);
        },
      });
      const age = (Date.now() - openedAt) / 1000;
      const result = await reader.census([marker], age);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.members.get(marker)).toEqual([pid]);
      const read = calls.find((c) => c.includes("-p"))!;
      const listed = read[read.indexOf("-p") + 1]!.split(",").map(Number);
      expect(listed).toContain(pid);
      // launchd (pid 1) was born long before the scope: its environment is
      // never read (a vitest worker, forked moments ago, legitimately is).
      expect(listed).not.toContain(1);
      expect(calls.some((c) => c.includes("-A") && c.includes("-E"))).toBe(false);
      expect(await reader.confirm(pid, marker)).toBe(true);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 20_000);
});
