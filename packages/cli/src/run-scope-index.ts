/**
 * The daemon's durable run-scope index (`daemon/run-scopes.json`): the
 * discovery record a crashed daemon's next life needs to end what its runs
 * left running, and the live-capture store the directive's second membership
 * source writes to.
 *
 * One entry per run: the marker, the run id, the daemon identity that opened
 * it (measured birth — a stale "running" row of a dead generation is never a
 * live owner), the run's recorded descendants `(pid, pgid, birth)` and the
 * birth floor of its scope. Written BEFORE the first launch; an entry is
 * retired only after a verified settlement (every census source succeeded,
 * nothing survived or stayed unreadable) and is otherwise kept as
 * `unresolved` with its outcome. Daemon start settles or discloses every
 * entry whose owner is not provably live BEFORE the workspace sweep, and never
 * touches a grammar-shaped marker that is not in this index (the embedding
 * host carries its own installation marker). Cooperative shutdown never
 * erases the file: unresolved entries are the next start's duty.
 *
 * Capture rides the daemon's existing 2 s pids tick (no new timer): one
 * asynchronous process-table snapshot per tick, each live harness root's
 * descendants walked by PPID while the chain is intact (Cursor `setsid`s its
 * shells, so a shell and its `find` are captured within one tick of being
 * spawned), new rows appended to that run's entry and persisted.
 */
import { readFileSync, renameSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  compareProcessIdentity,
  createProcessTableReader,
  defaultAsyncProcessIdentityReader,
  descendantProcessRows,
  isKnownProcessIdentity,
  liveChildProcesses,
  mintRunScopeMarker,
  reapScopeMembers,
  type AsyncProcessIdentityReader,
  type CapturedProcess,
  type KnownProcessIdentity,
  type ProcessTableReader,
  type ScopeReapOptions,
  type ScopeReapOutcome,
} from "@claudexor/core";
import type { RunScopeCustodian } from "@claudexor/orchestrator";
import { daemonDir, logPath } from "@claudexor/daemon";
import { logLine } from "./daemon-lifecycle.js";

export const RUN_SCOPE_INDEX_FILE = "run-scopes.json";

interface RunScopeOutcomeSummary {
  coverage: ScopeReapOutcome["coverage"];
  census: ScopeReapOutcome["census"];
  census_failure: string | null;
  ended: number;
  survivors: number[];
  unreadable: number[];
  reused_groups: number[];
  restricted: boolean;
  completeness: ScopeReapOutcome["completeness"];
}

export interface RunScopeEntry {
  marker: string;
  run_id: string;
  /** The daemon that opened the scope; null when its own identity was unreadable. */
  owner: KnownProcessIdentity | null;
  state: "open" | "unresolved";
  opened_at: string;
  settled_at?: string;
  /** Birth floor of the scope: the harness root's `lstart` at first capture. */
  scope_start: string | null;
  captured: CapturedProcess[];
  outcome?: RunScopeOutcomeSummary;
}

interface RunScopeIndexFile {
  schema_version: 1;
  entries: RunScopeEntry[];
}

export interface DaemonRunScopeIndexOptions {
  path: string;
  /** The daemon's own measured identity (memoised; read asynchronously once). */
  owner?: () => Promise<KnownProcessIdentity | null>;
  identity?: AsyncProcessIdentityReader;
  table?: ProcessTableReader;
  reap?: (opts: ScopeReapOptions) => Promise<ScopeReapOutcome>;
  /** Live harness roots with their markers (default: the process registry). */
  roots?: () => ReadonlyArray<{ pid: number; scopeMarker?: string }>;
  log?: (message: string) => void;
  now?: () => string;
}

function summarize(outcome: ScopeReapOutcome): RunScopeOutcomeSummary {
  return {
    coverage: outcome.coverage,
    census: outcome.census,
    census_failure: outcome.censusFailure,
    ended: outcome.ended.length,
    survivors: outcome.survivors.map((m) => m.pid),
    unreadable: outcome.unreadable.map((u) => u.pid),
    reused_groups: outcome.reusedGroups,
    restricted: outcome.restricted,
    completeness: outcome.completeness,
  };
}

function describe(entry: RunScopeEntry, outcome: ScopeReapOutcome): string {
  return (
    `scope ${entry.marker.slice(-8)} of run ${entry.run_id}: ` +
    `${outcome.settled ? "settled" : "UNRESOLVED"} (${outcome.coverage}, census ${outcome.census}` +
    `${outcome.censusFailure ? `: ${outcome.censusFailure}` : ""}; ended ${outcome.ended.length}, ` +
    `survivors ${outcome.survivors.map((m) => m.pid).join(",") || "-"}, ` +
    `unreadable ${outcome.unreadable.map((u) => u.pid).join(",") || "-"}` +
    `${outcome.reusedGroups.length ? `, reused groups ${outcome.reusedGroups.join(",")}` : ""})`
  );
}

export class DaemonRunScopeIndex implements RunScopeCustodian {
  private entries: RunScopeEntry[] | null = null;
  private writes: Promise<void> = Promise.resolve();
  private ownerIdentity: Promise<KnownProcessIdentity | null> | null = null;
  private capturing: Promise<void> | null = null;
  private readonly identity: AsyncProcessIdentityReader;
  private readonly table: ProcessTableReader | null;
  private readonly reap: (opts: ScopeReapOptions) => Promise<ScopeReapOutcome>;
  private readonly roots: () => ReadonlyArray<{ pid: number; scopeMarker?: string }>;
  private readonly log: (message: string) => void;
  private readonly now: () => string;

  constructor(private readonly options: DaemonRunScopeIndexOptions) {
    this.identity = options.identity ?? defaultAsyncProcessIdentityReader;
    this.table =
      options.table ?? (process.platform === "win32" ? null : createProcessTableReader());
    this.reap = options.reap ?? reapScopeMembers;
    this.roots = options.roots ?? liveChildProcesses;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** The entries as last loaded/written (a fresh read on first use). */
  list(): RunScopeEntry[] {
    return [...this.load()];
  }

  async open(runId: string): Promise<{ marker: string }> {
    const marker = mintRunScopeMarker();
    const owner = await this.owner();
    this.load().push({
      marker,
      run_id: runId,
      owner,
      state: "open",
      opened_at: this.now(),
      scope_start: null,
      captured: [],
    });
    // Durable BEFORE the first launch. A persistence failure degrades to
    // in-process custody for this run (the barrier still reaps) and is
    // disclosed in the daemon log; it never fails the run.
    try {
      await this.persist();
    } catch (error) {
      this.log(
        `run-scope index: could not record scope for ${runId} before launch (${
          error instanceof Error ? error.message : String(error)
        }); crash recovery will not know this run's leftovers`,
      );
    }
    return { marker };
  }

  async settle(runId: string, marker: string): Promise<ScopeReapOutcome> {
    const entry = this.load().find((item) => item.marker === marker);
    const outcome = await this.reap({
      marker,
      ...(entry ? { captured: entry.captured, scopeStart: entry.scope_start } : {}),
      ...(this.table ? { table: this.table } : {}),
    });
    if (entry) {
      this.log(describe(entry, outcome));
      this.retireOrKeep(entry, outcome);
      try {
        await this.persist();
      } catch (error) {
        this.log(
          `run-scope index: could not record settlement of ${runId} (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
      }
    }
    return outcome;
  }

  /**
   * One capture pass (the daemon's pids tick calls it): record every live
   * harness root's descendants into its run's entry. Coalesced: a tick that
   * arrives while one runs is skipped, never queued.
   */
  captureTick(): Promise<void> {
    if (this.capturing) return this.capturing;
    this.capturing = this.captureOnce().finally(() => {
      this.capturing = null;
    });
    return this.capturing;
  }

  private async captureOnce(): Promise<void> {
    if (!this.table) return;
    const roots = this.roots().filter((root) => root.scopeMarker);
    if (roots.length === 0) return;
    const entries = this.load();
    const rows = await this.table.snapshot();
    if (rows === null) return; // unreadable table: nothing recorded, nothing erased
    let changed = false;
    for (const root of roots) {
      const entry = entries.find(
        (item) => item.marker === root.scopeMarker && item.state === "open",
      );
      if (!entry) continue;
      const known = new Set(entry.captured.map((c) => `${c.pid}:${c.birth}`));
      for (const row of descendantProcessRows(root.pid, rows)) {
        if (row.pid === root.pid && entry.scope_start === null) {
          entry.scope_start = row.birth;
          changed = true;
        }
        const key = `${row.pid}:${row.birth}`;
        if (known.has(key)) continue;
        known.add(key);
        entry.captured.push({ pid: row.pid, pgid: row.pgid, birth: row.birth });
        changed = true;
      }
    }
    if (!changed) return;
    try {
      await this.persist();
    } catch (error) {
      this.log(
        `run-scope index: capture could not be persisted (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }

  /**
   * Daemon start: settle or disclose every entry whose owner is not provably
   * live (its recorded daemon identity no longer matches a live process; an
   * unreadable or unrecorded owner is not proof of life either — a root
   * authority lease admits one daemon per root, so a previous generation's
   * run cannot still be running). Markers absent from the index are never
   * touched. Returns the disclosed actions for the startup diagnostics.
   */
  async settleDeadOwners(): Promise<string[]> {
    const actions: string[] = [];
    const entries = this.load();
    if (entries.length === 0) return actions;
    for (const entry of [...entries]) {
      if (await this.ownerLive(entry)) {
        actions.push(
          `scope ${entry.marker.slice(-8)} of run ${entry.run_id}: owner ${entry.owner?.pid} is live; untouched`,
        );
        continue;
      }
      let outcome: ScopeReapOutcome;
      try {
        outcome = await this.reap({
          marker: entry.marker,
          captured: entry.captured,
          scopeStart: entry.scope_start,
          ...(this.table ? { table: this.table } : {}),
        });
      } catch (error) {
        actions.push(
          `scope ${entry.marker.slice(-8)} of run ${entry.run_id}: reap failed (${
            error instanceof Error ? error.message : String(error)
          }); kept`,
        );
        continue;
      }
      actions.push(describe(entry, outcome));
      this.retireOrKeep(entry, outcome);
    }
    try {
      await this.persist();
    } catch (error) {
      actions.push(
        `run-scope index could not be rewritten (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return actions;
  }

  private async ownerLive(entry: RunScopeEntry): Promise<boolean> {
    if (!entry.owner) return false;
    const observed = await this.identity.read(entry.owner.pid);
    return compareProcessIdentity(entry.owner, observed) === "same";
  }

  private retireOrKeep(entry: RunScopeEntry, outcome: ScopeReapOutcome): void {
    const entries = this.load();
    // A host with no census at all (`unsupported`, Windows) can never settle
    // an entry: keeping it would re-reap it at every start and grow the file
    // without bound, so it is retired once its outcome has been disclosed.
    if (outcome.settled || outcome.census === "unsupported") {
      const at = entries.indexOf(entry);
      if (at >= 0) entries.splice(at, 1);
      return;
    }
    entry.state = "unresolved";
    entry.settled_at = this.now();
    entry.outcome = summarize(outcome);
  }

  private owner(): Promise<KnownProcessIdentity | null> {
    this.ownerIdentity ??= (async () => {
      if (this.options.owner) return this.options.owner();
      const self = await this.identity.read(process.pid);
      return self.status === "known" ? self : null;
    })();
    return this.ownerIdentity;
  }

  private load(): RunScopeEntry[] {
    if (this.entries) return this.entries;
    this.entries = [];
    let text: string;
    try {
      text = readFileSync(this.options.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return this.entries; // never written: empty
      // Unknown is not empty: an unreadable index is disclosed and left in
      // place (the next write would replace it, so it is moved aside first).
      this.preserveUnreadable(
        `read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.entries;
    }
    let raw: Partial<RunScopeIndexFile>;
    try {
      raw = JSON.parse(text) as Partial<RunScopeIndexFile>;
      if (
        !raw ||
        typeof raw !== "object" ||
        raw.schema_version !== 1 ||
        !Array.isArray(raw.entries)
      )
        throw new Error("not a run-scope index (schema_version 1 with an entries array)");
    } catch (error) {
      this.preserveUnreadable(
        `parse failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.entries;
    }
    for (const value of raw.entries) {
      const entry = value as Partial<RunScopeEntry>;
      if (
        typeof entry.marker !== "string" ||
        typeof entry.run_id !== "string" ||
        (entry.state !== "open" && entry.state !== "unresolved")
      )
        continue;
      this.entries.push({
        marker: entry.marker,
        run_id: entry.run_id,
        owner: isKnownProcessIdentity(entry.owner) ? entry.owner : null,
        state: entry.state,
        opened_at: typeof entry.opened_at === "string" ? entry.opened_at : "",
        ...(typeof entry.settled_at === "string" ? { settled_at: entry.settled_at } : {}),
        scope_start: typeof entry.scope_start === "string" ? entry.scope_start : null,
        captured: Array.isArray(entry.captured)
          ? entry.captured.filter(
              (c): c is CapturedProcess =>
                !!c &&
                Number.isSafeInteger((c as CapturedProcess).pid) &&
                Number.isSafeInteger((c as CapturedProcess).pgid) &&
                typeof (c as CapturedProcess).birth === "string",
            )
          : [],
        ...(entry.outcome ? { outcome: entry.outcome } : {}),
      });
    }
    return this.entries;
  }

  /** The unreadable file's bytes are evidence of unknown obligations: keep them beside the index. */
  private preserveUnreadable(reason: string): void {
    const aside = `${this.options.path}.unreadable-${Date.now()}`;
    let moved = false;
    try {
      renameSync(this.options.path, aside);
      moved = true;
    } catch {
      /* nothing to move (or no permission): the disclosure below still names the problem */
    }
    this.log(
      `run-scope index ${this.options.path} is unreadable (${reason}); ` +
        (moved ? `preserved as ${aside}; ` : "could not be moved aside; ") +
        "its cleanup obligations are UNKNOWN until an operator inspects it; starting an empty index",
    );
  }

  /** Serialized atomic rewrite (tmp + rename), one writer at a time. */
  private persist(): Promise<void> {
    const body: RunScopeIndexFile = { schema_version: 1, entries: this.load() };
    const text = JSON.stringify(body, null, 2);
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.options.path), { recursive: true });
      const tmp = `${this.options.path}.tmp`;
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, this.options.path);
    });
    this.writes = write.catch(() => {});
    return write;
  }
}

let shared: DaemonRunScopeIndex | null = null;

/** The one index of this daemon (lazily bound to the daemon data root). */
export function daemonRunScopeIndex(): DaemonRunScopeIndex {
  shared ??= new DaemonRunScopeIndex({
    path: join(daemonDir(), RUN_SCOPE_INDEX_FILE),
    log: (message) => logLine(logPath(), message),
  });
  return shared;
}
