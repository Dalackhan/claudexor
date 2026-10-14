import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { mintRunScopeMarker } from "./process-scope.js";
import { ScopeReaper, reapScopeMembers } from "./process-scope-census.js";
import {
  createDarwinScopeCensusReader,
  createLinuxScopeCensusReader,
  parseEtime,
  psSelectionVanished,
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

/** Seconds as `ps -o etime=` spells them (`[[dd-]hh:]mm:ss`). */
function etimeText(seconds: number): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
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
        40: etimeText(age + SCOPE_AGE_SLACK_SECONDS), // exactly age+slack
        50: etimeText(age + SCOPE_AGE_SLACK_SECONDS + 1), // one second older
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

  it("exit 1 with a message on stderr is a real ps error, never 'every pid vanished': the census fails and confirm answers unreadable (both directions)", async () => {
    const etimeOnly = fakePs({ etime: { 20: "00:01" }, env: {} });
    const erroring: PsRunner = async (args, onLine) =>
      args.includes("-E")
        ? { status: "failed", reason: "ps exited 1", stderr: "ps: malloc: Cannot allocate memory" }
        : etimeOnly.ps(args, onLine);
    const reader = createDarwinScopeCensusReader({ ps: erroring });
    expect(await reader.census([M], 1)).toEqual({
      status: "failed",
      reason: "ps exited 1",
      stderr: "ps: malloc: Cannot allocate memory",
    });
    expect(await reader.confirm(20, M)).toBeNull();
    // The same exit code with nothing on stderr is the vanished selection.
    const vanished: PsRunner = async () => ({ status: "failed", reason: "ps exited 1" });
    expect(await createDarwinScopeCensusReader({ ps: vanished }).confirm(20, M)).toBe(false);
    expect(psSelectionVanished({ status: "failed", reason: "ps exited 1" }, false)).toBe(true);
    expect(
      psSelectionVanished({ status: "failed", reason: "ps exited 1", stderr: "" }, false),
    ).toBe(true);
    expect(psSelectionVanished({ status: "failed", reason: "ps exited 1" }, true)).toBe(false);
    expect(psSelectionVanished({ status: "failed", reason: "ps exited 2" }, false)).toBe(false);
  });

  it("coalesces concurrent callers under the LARGEST age (a superset); any caller without an age means the full census", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let gated = true;
    const fake = fakePs({
      etime: { 10: "3-00:00:00", 20: "02:00", 30: "00:02" },
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
      "30", // first scan: age 10 (+60 s slack) admits only the 2 s old process
      "20,30", // second scan: limit 100 (+60 s) covers the two-minute-old one too
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

describe("darwin census membership is the exact entry ps shows", () => {
  it("a platform binary whose environment is shown is a member; withheld (arguments only) or carrying another scope's marker it is absent: false, never unreadable (both directions)", async () => {
    const other = mintRunScopeMarker();
    const fake = fakePs({
      etime: {},
      env: {
        10: `/bin/sleep 600 PATH=/usr/bin:/bin ${M}=1`, // a host that shows the environment
        20: "/bin/sleep 600", // a host that withholds it (SIP): ps prints the arguments only
        30: `/bin/sleep 600 ${other}=1 HOME=/x`, // another scope's marker
      },
    });
    const reader = createDarwinScopeCensusReader({ ps: fake.ps });
    expect(await reader.census([M, other])).toEqual({
      status: "ok",
      members: new Map([
        [M, [10]],
        [other, [30]],
      ]),
      unreadable: 0,
    });
    expect(await reader.confirm(10, M)).toBe(true);
    // A withheld environment reads exactly like an absent entry: nothing tells
    // them apart, which is why a settled darwin reap is never provably complete.
    expect(await reader.confirm(20, M)).toBe(false);
    expect(await reader.confirm(30, M)).toBe(false);
    expect(await reader.confirm(30, other)).toBe(true);
  });
});

/**
 * `ps` whose age listings wait for the test (one hold per listing, oldest
 * answered first); environment reads find no row.
 */
function heldPs(listing: string[] | PsRunFailure) {
  const calls: string[] = [];
  const held: Array<() => void> = [];
  let open = false;
  const ps: PsRunner = async (args, onLine) => {
    if (args.includes("pid=,etime=")) {
      calls.push("ages");
      if (!open) await new Promise<void>((resolve) => held.push(resolve));
      if (!Array.isArray(listing)) return listing;
      for (const row of listing) onLine(row);
      return null;
    }
    calls.push(args.includes("-p") ? "environments" : "every environment");
    return null;
  };
  return {
    ps,
    calls,
    held: () => held.length,
    release: () => held.shift()!(),
    /** Answer every held listing, and every later one at once. */
    open: () => {
      open = true;
      for (const resume of held.splice(0)) resume();
    },
  };
}

/** One reap through `census` whose settlement deadline passes only when the test fires it. */
function reapUntilFired(marker: string, census: ScopeCensusReader) {
  let fire!: () => void;
  const outcome = new ScopeReaper().reap({
    marker,
    census,
    scopeStartAt: new Date(Date.now() - 1_000).toISOString(),
    deadlineTimer: () => new Promise<void>((resolve) => (fire = resolve)),
    deadlineMs: 60_000,
    graceMs: 10,
    probeIntervalMs: 5,
    platform: "darwin",
    signal: () => {
      throw new Error("this scope has no member to signal");
    },
  });
  return { outcome, fire: () => fire() };
}

describe("a settlement deadline that passes during a census scan", () => {
  it.each<[string, string[] | PsRunFailure, string]>([
    ["rows", ["  4242 00:01"], "environments"],
    ["a failure", { status: "failed", reason: "ps exceeded 10000ms" }, "every environment"],
  ])(
    "an age listing answering with %s after the deadline starts no environment read; in time it does (both directions)",
    async (_, listing, read) => {
      const fake = heldPs(listing);
      const reader = createDarwinScopeCensusReader({ ps: fake.ps });
      const expired = reapUntilFired(M, reader);
      expect(fake.calls).toEqual(["ages"]); // in flight when the deadline passes
      expired.fire();
      expect(await expired.outcome).toMatchObject({ incomplete: true, settled: false });
      fake.open();
      // A live caller queued behind that scan is served only once it finished.
      expect((await reader.census([M], 1)).status).toBe("ok");
      expect(fake.calls).toEqual(["ages", "ages", read]);
      // Asked directly with an expiry, the scan's answer is unknown, never `ok`.
      const direct = heldPs(listing);
      let gone = false;
      const answer = createDarwinScopeCensusReader({ ps: direct.ps }).census([M], 1, () => gone);
      gone = true;
      direct.open();
      expect(await answer).toMatchObject({ status: "failed" });
      expect(direct.calls).toEqual(["ages"]);
      // Nothing expired: the same listing leads to the environment read.
      const timely = heldPs(listing);
      const live = reapUntilFired(M, createDarwinScopeCensusReader({ ps: timely.ps }));
      timely.open();
      expect(await live.outcome).toMatchObject({ incomplete: false, settled: true });
      expect(timely.calls).toEqual(["ages", read]);
    },
  );

  it("a request already past its deadline on arrival answers unknown and leaves the scanner free: the next live request scans at once (both directions)", async () => {
    // Through the reaper: its clock crosses the deadline between the lazy gate
    // and the scanner, so the request arrives expired.
    let t = 0;
    const fake = heldPs(["  4242 00:01"]);
    fake.open();
    const reader = createDarwinScopeCensusReader({ ps: fake.ps });
    const crossed = await new ScopeReaper().reap({
      marker: M,
      census: reader,
      scopeStartAt: new Date(Date.now() - 1_000).toISOString(),
      now: () => t++,
      deadlineMs: 2,
      deadlineTimer: () => new Promise<void>(() => {}),
      platform: "darwin",
      signal: () => {
        throw new Error("this scope has no member to signal");
      },
    });
    // A deadline cut stays `incomplete`, never a failed census.
    expect(crossed).toMatchObject({ census: "ok", censusFailure: null, incomplete: true });
    expect(fake.calls).toEqual([]);
    const next = reader.census([M], 1);
    expect(fake.calls).toEqual(["ages"]); // started at once, not parked behind the expired one
    expect(await next).toMatchObject({ status: "ok" });
    // Asked directly, on both readers.
    const direct = heldPs(["  4242 00:01"]);
    direct.open();
    const darwin = createDarwinScopeCensusReader({ ps: direct.ps });
    expect(await darwin.census([M], 1, () => true)).toMatchObject({ status: "failed" });
    const later = darwin.census([M], 1);
    expect(direct.calls).toEqual(["ages"]);
    expect(await later).toMatchObject({ status: "ok" });
    let listings = 0;
    const linux = createLinuxScopeCensusReader({
      listProc: async () => {
        listings += 1;
        return ["100"];
      },
      readTextFile: async () => "PATH=/x\0",
      statUid: async () => 501,
      selfUid: 501,
    });
    expect(await linux.census([M], undefined, () => true)).toMatchObject({ status: "failed" });
    expect(listings).toBe(0);
    const after = linux.census([M]);
    expect(listings).toBe(1);
    expect(await after).toMatchObject({ status: "ok" });
  });

  it("a caller whose deadline passed while it queued starts no scan; a live caller sharing the batch keeps it, also when the other expires mid-scan (both directions)", async () => {
    const other = mintRunScopeMarker();
    const third = mintRunScopeMarker();
    const fake = heldPs(["  4242 00:01"]);
    const reader = createDarwinScopeCensusReader({ ps: fake.ps });
    const first = reapUntilFired(M, reader); // its scan is in flight
    const queued = reapUntilFired(other, reader); // waits for the next scan
    queued.fire();
    expect(await queued.outcome).toMatchObject({ incomplete: true, settled: false });
    fake.release();
    expect(await first.outcome).toMatchObject({ incomplete: false, settled: true });
    fake.open();
    expect((await reader.census([M], 1)).status).toBe("ok"); // served after anything still queued
    expect(fake.calls).toEqual(["ages", "environments", "ages", "environments"]);

    // Expired before the shared scan starts: the live caller's scan still runs.
    const before = heldPs(["  4242 00:01"]);
    const shared = createDarwinScopeCensusReader({ ps: before.ps });
    const leading = reapUntilFired(M, shared);
    const gone = reapUntilFired(other, shared);
    const live = reapUntilFired(third, shared);
    gone.fire();
    await gone.outcome;
    before.open();
    expect(await leading.outcome).toMatchObject({ settled: true });
    expect(await live.outcome).toMatchObject({ incomplete: false, settled: true });
    expect(before.calls).toEqual(["ages", "environments", "ages", "environments"]);

    // Expired while the shared scan lists ages: the environment read still starts.
    const during = heldPs(["  4242 00:01"]);
    const mixed = createDarwinScopeCensusReader({ ps: during.ps });
    const head = reapUntilFired(M, mixed);
    const leaving = reapUntilFired(other, mixed);
    const staying = reapUntilFired(third, mixed);
    during.release();
    await head.outcome;
    await vi.waitFor(() => expect(during.held()).toBe(1)); // the shared scan's listing
    leaving.fire();
    expect(await leaving.outcome).toMatchObject({ incomplete: true });
    during.open();
    expect(await staying.outcome).toMatchObject({ incomplete: false, settled: true });
    expect(during.calls).toEqual(["ages", "environments", "ages", "environments"]);
  });
});

describe.runIf(process.platform === "darwin")("runPs on this host", () => {
  it("keeps what ps wrote to stderr: none for a vanished pid, the message for a real error", async () => {
    const vanished = await runPs(["-o", "pid=", "-p", "99990"], () => {});
    expect(vanished).toEqual({ status: "failed", reason: "ps exited 1" });
    const invalid = await runPs(["-o", "pid=", "-p", "not-a-pid"], () => {});
    expect(invalid?.reason).toBe("ps exited 1");
    expect(invalid?.stderr).toMatch(/process id/i);
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
