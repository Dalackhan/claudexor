import { Thread } from "@claudexor/schema";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import { access } from "node:fs/promises";
import type { EngineStore } from "./store.js";
import { decodeBody } from "./thread-rows.js";
import { isServedPid } from "./generations.js";
import { retentionPages } from "./retention-pages.js";
import { retentionChanges } from "./retention-changes.js";
import { RetentionReferenceReader } from "./retention-reference-reader.js";
import { commandRetentionReferences } from "./retention-command-references.js";

export interface DiskRetentionReferences {
  /** Exact inventory witness, used for lane sweeping that cannot absorb new owners. */
  isCurrent: () => boolean;
  /** Cooperatively absorb changed owners, then synchronously recheck before expiry. */
  refresh?: () => Promise<void>;
  recheck?: () => boolean;
  /** Native file scans additionally require no intervening work/session mutation. */
  nativeCurrent?: () => boolean;
  hasActiveCommands?: () => boolean;
  /** Caller releases the observation after all deletions, including error paths. */
  close?: () => void;
  projectRoots: string[];
  /** Retained active/archived registrations; thread root names alone are not ownership. */
  registeredProjectRoots: Set<string>;
  protectedProjectRoots: Set<string>;
  referencedRunIds: Set<string>;
  nativeSessions: Map<string, Set<string>>;
  records: Array<{ runId: string; state: string; finishedAt?: string }>;
}

/** Maintenance's served thread listing, including unfinished purges. Unlike
 * public synchronous listing it does not stat every registered project root. */
export async function diskRetentionThreads(store: EngineStore): Promise<Thread[]> {
  const result: Thread[] = [];
  const served = new Map<number, boolean>();
  const roots = new Map(
    (
      store
        .prepare(
          `SELECT current_pid AS pid,root FROM project WHERE status='active'
       AND pid=CAST((SELECT value FROM meta WHERE key='global_pid') AS INTEGER)`,
        )
        .all() as Array<{ pid: number; root: string }>
    ).map((row) => [row.pid, row.root]),
  );
  for await (const rows of retentionPages<{ pid: number; body: Uint8Array }>(
    store,
    "thread",
    "pid,body",
  )) {
    for (const row of rows) {
      await yieldToAdmission();
      if (!served.has(row.pid)) served.set(row.pid, isServedPid(store, row.pid));
      if (!served.get(row.pid)) continue;
      const thread = Thread.parse(decodeBody(row));
      const root = roots.get(row.pid);
      if (
        thread.state !== "purged" &&
        root &&
        !(await access(root).then(
          () => true,
          () => false,
        ))
      )
        continue;
      result.push(thread);
    }
  }
  return result;
}

/** Retirement reads all retained generations, including archived projects. Public
 * listing/admission remains served-generation-only. Any unreadable reference throws. */
export async function diskRetentionReferences(
  store: EngineStore,
  ignoreThreadIds: ReadonlySet<string> = new Set(),
): Promise<DiskRetentionReferences> {
  const changesObserved = retentionChanges(store);
  try {
    // EngineStore is the sole writer. SQLite's own change count covers every
    // mutation for lane sweeping, which cannot absorb new owners. Run/native
    // proofs below reread changed owners instead. No cursor survives a yield.
    const changes = store.prepare("SELECT total_changes() AS n");
    const version = (changes.get() as { n: number }).n;
    const isCurrent = () => (changes.get() as { n: number }).n === version;
    const registeredProjectRoots = new Set(
      (store.prepare("SELECT root FROM project").all() as Array<{ root: string }>).map(
        (r) => r.root,
      ),
    );
    const roots = new Set(registeredProjectRoots);
    const protectedProjectRoots = new Set<string>();
    const unavailable = store
      .prepare(
        `SELECT q.id,q.name,p.root FROM partition q
    LEFT JOIN project p ON p.id=q.project_id WHERE q.status NOT IN ('ready','archived')`,
      )
      .all() as Array<{ id: number; name: string; root: string | null }>;
    for (const partition of unavailable) {
      if (partition.root) protectedProjectRoots.add(partition.root);
      const commandRoots = store
        .prepare(
          "SELECT DISTINCT scope_root AS root FROM command WHERE pid=? AND scope_root IS NOT NULL",
        )
        .all(partition.id) as Array<{ root: string }>;
      for (const { root } of commandRoots) protectedProjectRoots.add(root);
      if (!partition.root && partition.name === "global") {
        throw new Error("disk retention references require recovery of a global generation");
      }
    }
    // A current project without a ready/archive generation cannot prove absence either.
    for (const row of store
      .prepare(
        `SELECT p.root FROM project p LEFT JOIN partition q ON q.id=p.current_pid
    WHERE q.id IS NULL OR q.status NOT IN ('ready','archived')`,
      )
      .all() as Array<{ root: string }>) {
      protectedProjectRoots.add(row.root);
    }
    const reader = new RetentionReferenceReader(store, ignoreThreadIds);
    for await (const rows of retentionPages<{ state: string; body: Uint8Array }>(
      store,
      "thread",
      "state,body",
    )) {
      for (const row of rows) {
        await yieldToAdmission();
        const thread = reader.thread(row);
        if (!thread) continue;
        for (const sessionRow of store
          .prepare("SELECT thread_id,harness_id,body FROM session WHERE thread_id=?")
          .all(thread.id) as Array<{ thread_id: string; harness_id: string; body: Uint8Array }>)
          reader.session(sessionRow, thread);
        for (const turnRow of store
          .prepare("SELECT thread_id,body FROM turn WHERE thread_id=?")
          .all(thread.id) as Array<{ thread_id: string; body: Uint8Array }>) {
          await yieldToAdmission();
          reader.turn(turnRow, thread);
        }
      }
    }
    for (const row of store
      .prepare("SELECT run_id FROM interaction WHERE state='pending'")
      .all() as Array<{ run_id: string }>)
      reader.add(row.run_id);
    const commands = await commandRetentionReferences(store, reader.runs);
    const readChange = ({
      table,
      id,
    }: Parameters<Parameters<typeof changesObserved.current>[0]>[0]) => {
      if (table === "command") commands.refresh(id);
      else if (table === "blob") {
        const owner = store.prepare("SELECT 1 FROM command WHERE params_sha=? LIMIT 1").get(id);
        if (owner) throw new Error("immutable retention command body changed during inventory");
      } else if (table !== "project" && table !== "partition") reader.refresh(table, id);
    };
    const recheck = () => changesObserved.current(readChange);
    const refresh = () => changesObserved.refresh(readChange);
    await refresh();
    for (const root of reader.roots) roots.add(root);
    return {
      isCurrent,
      refresh,
      recheck,
      nativeCurrent: () =>
        recheck() && changesObserved.nativeCurrent() && !commands.hasActiveCommands(),
      hasActiveCommands: commands.hasActiveCommands,
      close: changesObserved.close,
      projectRoots: [...roots],
      registeredProjectRoots,
      protectedProjectRoots,
      referencedRunIds: reader.runs,
      records: commands.records,
      nativeSessions: reader.sessions,
    };
  } catch (error) {
    changesObserved.close();
    throw error;
  }
}
