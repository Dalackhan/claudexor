/**
 * Platform census readers for the run-scope custodian: which live processes
 * carry a scope marker in their environment, read from kernel state without
 * ever buffering, logging or persisting environment bytes. macOS streams one
 * `ps -E -ww … -o pid=,command=` over the processes no older than the scope
 * (an `etime` listing first; full when no age is known); Linux reads `/proc/<pid>/environ` with
 * bounded concurrency and an exact NUL-entry match. Settlement (the union
 * with recorded groups, the deadline, TERM/KILL) lives in
 * `process-scope-census.ts`; this module only answers "who carries it now".
 */
import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { SCOPE_MARKER_VALUE } from "./process-scope.js";

export type ScopeCensusResult =
  /** Every requested marker mapped to the pids that carry it right now. */
  | { status: "ok"; members: Map<string, number[]>; unreadable: number }
  /** The table could not be read completely: unknown, never empty. */
  | { status: "failed"; reason: string };

export interface ScopeCensusReader {
  /**
   * Every live process carrying any of `markers`. `maxAgeSeconds`, when the
   * caller knows it, is the scope's age: a process older than that was
   * created before the marker was minted and cannot carry it, so a reader may
   * skip its environment (darwin does; a failed age listing falls back to the
   * full read). Omitted = the full census.
   */
  census(markers: readonly string[], maxAgeSeconds?: number): Promise<ScopeCensusResult>;
  /**
   * Affirmative membership of ONE pid immediately before it is signalled:
   * true = the exact entry is present now, false = absent (vanished or
   * reused), null = unreadable.
   */
  confirm(pid: number, marker: string): Promise<boolean | null>;
}

// `ps` resolved through the pinned child PATH (`/usr/bin:/bin`), exactly like
// `process-tree.ts`: both readers find or miss `ps` the same way (a host that
// keeps it elsewhere — NixOS — is a disclosed, consistent miss).
const PS_COMMAND = "ps";
const CENSUS_TIMEOUT_MS = 10_000;
export const LINUX_CONCURRENCY = 8;
/** Slack added to the scope's age before a process is deemed too old to carry its marker. */
export const SCOPE_AGE_SLACK_SECONDS = 5;

/** `ps -o etime=` text — `[[dd-]hh:]mm:ss`, elapsed since the process started — as seconds; null for anything else. */
export function parseEtime(text: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)
  );
}

/**
 * The scope's age for a census: seconds since `openedAt` (an ISO time)
 * against the REAL wall clock — `ps` measures `etime` against the same clock
 * at the same moment — recomputed by the caller at every scan. Undefined (the
 * full census) when no opening time is known or it does not parse.
 */
export function scopeAgeSeconds(
  openedAt: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  const openedAtMs = openedAt ? Date.parse(openedAt) : Number.NaN;
  return Number.isFinite(openedAtMs) ? Math.max(0, (now - openedAtMs) / 1000) : undefined;
}

function markerEntry(marker: string): string {
  return `${marker}=${SCOPE_MARKER_VALUE}`;
}

/**
 * One `ps -E` line: the leading pid and which of `markers` appear as a whole
 * whitespace-delimited token `NAME=1`. Pure, so the matcher is testable
 * without a process table.
 */
export function parseDarwinCensusLine(line: string, markers: readonly string[]): number | null {
  const match = /^\s*(\d+)\s/.exec(line);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function darwinLineCarriesMarker(line: string, marker: string): boolean {
  const entry = markerEntry(marker);
  let from = 0;
  for (;;) {
    const at = line.indexOf(entry, from);
    if (at === -1) return false;
    const before = at === 0 ? " " : line[at - 1];
    const after = at + entry.length >= line.length ? " " : line[at + entry.length];
    if (/\s/.test(before!) && /\s/.test(after!)) return true;
    from = at + 1;
  }
}

/** Exact NUL-delimited entry match over a Linux `environ` buffer. */
export function environCarriesMarker(environ: string, marker: string): boolean {
  const entry = markerEntry(marker);
  for (const item of environ.split("\0")) if (item === entry) return true;
  return false;
}

/**
 * Serialize scans so concurrent reaps share ONE process-table read: a request
 * arriving while a scan runs joins the NEXT scan (which covers the union of
 * the markers requested meanwhile, under the LARGEST age limit — a superset —
 * or the full census when any of them has no limit), never a third concurrent
 * read.
 */
class CoalescingCensus {
  private running: Promise<void> | null = null;
  private waiting: Array<{
    markers: readonly string[];
    maxAgeSeconds: number | undefined;
    settle: (r: ScopeCensusResult) => void;
  }> = [];

  constructor(
    private readonly scan: (
      markers: readonly string[],
      maxAgeSeconds: number | undefined,
    ) => Promise<ScopeCensusResult>,
  ) {}

  census(markers: readonly string[], maxAgeSeconds?: number): Promise<ScopeCensusResult> {
    return new Promise<ScopeCensusResult>((settle) => {
      this.waiting.push({ markers, maxAgeSeconds, settle });
      if (!this.running) this.running = this.drain();
    });
  }

  private async drain(): Promise<void> {
    while (this.waiting.length > 0) {
      const batch = this.waiting.splice(0);
      const union = [...new Set(batch.flatMap((item) => item.markers))];
      const limit = batch.some((item) => item.maxAgeSeconds === undefined)
        ? undefined
        : Math.max(...batch.map((item) => item.maxAgeSeconds!));
      let result: ScopeCensusResult;
      try {
        result = await this.scan(union, limit);
      } catch (error) {
        result = {
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      for (const item of batch) {
        if (result.status !== "ok") {
          item.settle(result);
          continue;
        }
        const members = new Map<string, number[]>();
        for (const marker of item.markers) members.set(marker, result.members.get(marker) ?? []);
        item.settle({ status: "ok", members, unreadable: result.unreadable });
      }
    }
    this.running = null;
  }
}

export type PsRunFailure = { status: "failed"; reason: string };
/** Runs `ps` with `args`, streaming stdout lines; null on success (test seam). */
export type PsRunner = (
  args: string[],
  onLine: (line: string) => void,
) => Promise<PsRunFailure | null>;

export const runPs: PsRunner = (args, onLine) => {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: PsFailure | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(PS_COMMAND, args, {
        stdio: ["ignore", "pipe", "ignore"],
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      });
    } catch (error) {
      settle({ status: "failed", reason: `ps spawn failed: ${String(error)}` });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      settle({ status: "failed", reason: `ps exceeded ${CENSUS_TIMEOUT_MS}ms` });
    }, CENSUS_TIMEOUT_MS);
    timer.unref?.();
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    let readFailure: string | null = null;
    lines.on("line", (line) => {
      try {
        onLine(line);
      } catch (error) {
        readFailure ??= error instanceof Error ? error.message : String(error);
      }
    });
    child.stdout!.on("error", (error) => {
      readFailure ??= `ps stdout error: ${error.message}`;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      settle({ status: "failed", reason: `ps failed to start: ${error.message}` });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      lines.close();
      if (readFailure) settle({ status: "failed", reason: readFailure });
      else if (code !== 0) settle({ status: "failed", reason: `ps exited ${code ?? signal}` });
      else settle(null);
    });
  });
};

type PsFailure = PsRunFailure;

/**
 * macOS: one streamed `ps -E -ww … -o pid=,command=` per census. With a known
 * scope age the environments read are only those of processes no older than
 * the scope (plus slack): a cheap `ps -A -o pid=,etime=` listing first, then
 * `-p` over the young pids (none → an `ok` census with no members). `etime`
 * is elapsed time, measured by `ps` against the same wall clock at the same
 * moment as the age, so time zones, DST and wall-clock steps cannot hide a
 * member; a row whose `etime` cannot be parsed is read, and a failed listing
 * falls back to the full census. `confirm` is unchanged.
 */
export function createDarwinScopeCensusReader(deps: { ps?: PsRunner } = {}): ScopeCensusReader {
  const ps = deps.ps ?? runPs;
  const candidates = async (maxAgeSeconds: number): Promise<number[] | PsFailure> => {
    const pids: number[] = [];
    const failure = await ps(["-A", "-o", "pid=,etime="], (line) => {
      const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
      if (!match) return;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) return;
      const age = parseEtime(match[2]!);
      if (age === null || age <= maxAgeSeconds + SCOPE_AGE_SLACK_SECONDS) pids.push(pid);
    });
    return failure ?? pids;
  };
  const coalescing = new CoalescingCensus(async (markers, maxAgeSeconds) => {
    const members = new Map<string, number[]>(markers.map((marker) => [marker, []]));
    let args = ["-E", "-ww", "-A", "-o", "pid=,command="];
    let listed = false;
    if (maxAgeSeconds !== undefined) {
      const young = await candidates(maxAgeSeconds);
      if (Array.isArray(young)) {
        if (young.length === 0) return { status: "ok", members, unreadable: 0 };
        args = ["-E", "-ww", "-o", "pid=,command=", "-p", young.join(",")];
        listed = true;
      }
    }
    let sawRow = false;
    const failure = await ps(args, (line) => {
      const pid = parseDarwinCensusLine(line, markers);
      if (pid === null) return;
      sawRow = true;
      for (const marker of markers) {
        if (darwinLineCarriesMarker(line, marker)) members.get(marker)!.push(pid);
      }
    });
    // `ps -p` exits 1 with no row when EVERY listed pid vanished meanwhile:
    // a complete, empty answer (a partly vanished list still exits 0).
    if (failure && listed && !sawRow && /exited 1$/.test(failure.reason))
      return { status: "ok", members, unreadable: 0 };
    return failure ?? { status: "ok", members, unreadable: 0 };
  });
  return {
    census: (markers, maxAgeSeconds) => coalescing.census(markers, maxAgeSeconds),
    async confirm(pid, marker) {
      let carries = false;
      let sawRow = false;
      const failure = await ps(["-E", "-ww", "-o", "pid=,command=", "-p", String(pid)], (line) => {
        if (parseDarwinCensusLine(line, [marker]) !== pid) return;
        sawRow = true;
        if (darwinLineCarriesMarker(line, marker)) carries = true;
      });
      // `ps -p` of a vanished pid exits 1 with no row: absent, not unreadable.
      if (failure && !sawRow && /exited 1$/.test(failure.reason)) return false;
      if (failure) return null;
      return carries;
    },
  };
}

export async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/** Linux: bounded-concurrency `/proc/<pid>/environ` reads, exact entry match. */
export function createLinuxScopeCensusReader(
  deps: {
    readTextFile?: (path: string) => Promise<string>;
    listProc?: () => Promise<string[]>;
    /** The owning uid of `/proc/<pid>` (null when unknown); default: fs.stat. */
    statUid?: (pid: number) => Promise<number | null>;
    selfUid?: number;
  } = {},
): ScopeCensusReader {
  const readTextFile = deps.readTextFile ?? ((path: string) => readFile(path, "utf8"));
  const listProc = deps.listProc ?? (() => readdir("/proc"));
  const statUid =
    deps.statUid ??
    (async (pid: number) => {
      try {
        return (await stat(`/proc/${pid}`)).uid;
      } catch {
        return null;
      }
    });
  const selfUid = deps.selfUid ?? process.getuid?.() ?? null;
  const readEnviron = async (pid: number): Promise<string | null | "vanished"> => {
    try {
      return await readTextFile(`/proc/${pid}/environ`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ESRCH") return "vanished";
      return null;
    }
  };
  const coalescing = new CoalescingCensus(async (markers) => {
    let names: string[];
    try {
      names = await listProc();
    } catch (error) {
      return { status: "failed", reason: `/proc unreadable: ${String(error)}` };
    }
    const pids = names.filter((name) => /^[1-9][0-9]*$/.test(name)).map(Number);
    const members = new Map<string, number[]>(markers.map((marker) => [marker, []]));
    let unreadable = 0;
    await mapBounded(pids, LINUX_CONCURRENCY, async (pid) => {
      const environ = await readEnviron(pid);
      if (environ === "vanished") return;
      if (environ === null) {
        // Only a process of OUR uid could carry our marker through ordinary
        // spawn (another uid cannot inherit our environment; a setuid binary
        // is part of the disclosed residual), so only a same-uid unreadable
        // environment makes the census incomplete.
        const uid = await statUid(pid);
        if (uid === null || selfUid === null || uid === selfUid) unreadable += 1;
        return;
      }
      for (const marker of markers) {
        if (environCarriesMarker(environ, marker)) members.get(marker)!.push(pid);
      }
    });
    return { status: "ok", members, unreadable };
  });
  return {
    census: (markers) => coalescing.census(markers),
    async confirm(pid, marker) {
      const environ = await readEnviron(pid);
      if (environ === "vanished") return false;
      if (environ === null) return null;
      return environCarriesMarker(environ, marker);
    },
  };
}

const defaultReaders = new Map<string, ScopeCensusReader | null>();

/**
 * The census reader for a platform; null where no environment census exists.
 * Memoised per platform so concurrent default reaps share ONE coalescing
 * scanner (the coalescer only helps when every reap uses the same instance).
 */
export function createScopeCensusReader(
  platform: string = process.platform,
): ScopeCensusReader | null {
  if (!defaultReaders.has(platform)) {
    defaultReaders.set(
      platform,
      platform === "darwin"
        ? createDarwinScopeCensusReader()
        : platform === "linux"
          ? createLinuxScopeCensusReader()
          : null,
    );
  }
  return defaultReaders.get(platform) ?? null;
}
