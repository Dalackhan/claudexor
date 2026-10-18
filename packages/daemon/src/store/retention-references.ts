import { Session, Thread, ThreadTurn } from "@claudexor/schema";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import { access } from "node:fs/promises";
import type { EngineStore } from "./store.js";
import { decodeBody } from "./thread-rows.js";
import { isServedPid } from "./generations.js";
import { retentionPages } from "./retention-pages.js";

export interface DiskRetentionReferences {
  /** Any SQL write invalidates this proof, including an admission that already finished. */
  isCurrent: () => boolean;
  projectRoots: string[];
  /** Retained active/archived registrations; thread root names alone are not ownership. */
  registeredProjectRoots: Set<string>;
  protectedProjectRoots: Set<string>;
  referencedRunIds: Set<string>;
  nativeSessions: Map<string, Set<string>>;
  records: Array<{ runId: string; state: string; finishedAt?: string }>;
}

const RetainedTurn = ThreadTurn.omit({ prompt: true });

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
  // EngineStore is the sole writer. SQLite's own change count covers every
  // mutation on that connection (even a rolled-back write conservatively
  // invalidates the proof). No transaction or cursor survives a yield.
  const changes = store.prepare("SELECT total_changes() AS n");
  const version = (changes.get() as { n: number }).n;
  const isCurrent = () => (changes.get() as { n: number }).n === version;
  const registeredProjectRoots = new Set(
    (store.prepare("SELECT root FROM project").all() as Array<{ root: string }>).map((r) => r.root),
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
  const referencedRunIds = new Set<string>();
  const nativeSessions = new Map<string, Set<string>>();
  const add = (id: string | null | undefined) => {
    if (id) referencedRunIds.add(id);
  };
  for await (const rows of retentionPages<{ state: string; body: Uint8Array }>(
    store,
    "thread",
    "state,body",
  )) {
    for (const row of rows) {
      if (row.state === "purged") continue;
      await yieldToAdmission();
      const thread = Thread.parse(decodeBody(row));
      if (thread.state !== row.state)
        throw new Error(`thread ${thread.id} retention state disagrees`);
      if (thread.repo) roots.add(thread.repo.root);
      if (ignoreThreadIds.has(thread.id)) continue;
      for (const sessionRow of store
        .prepare("SELECT harness_id,body FROM session WHERE thread_id=?")
        .all(thread.id) as Array<{ harness_id: string; body: Uint8Array }>) {
        const session = Session.parse(decodeBody(sessionRow));
        if (session.thread_id !== thread.id || session.harness_id !== sessionRow.harness_id)
          throw new Error("native session retention owner disagrees");
        if (session.native_session_id) {
          const ids = nativeSessions.get(session.harness_id) ?? new Set<string>();
          ids.add(session.native_session_id);
          nativeSessions.set(session.harness_id, ids);
        }
      }
      thread.run_ids.forEach(add);
      add(thread.head_run_id);
      for (const turnRow of store
        .prepare("SELECT body FROM turn WHERE thread_id=?")
        .all(thread.id) as Array<{ body: Uint8Array }>) {
        await yieldToAdmission();
        const turn = RetainedTurn.parse(decodeBody(turnRow));
        if (turn.thread_id !== thread.id) throw new Error("retention turn owner disagrees");
        [turn.run_id, turn.parent_run_id, turn.answers_plan_run_id, turn.plan_run_id].forEach(add);
      }
    }
  }
  for (const row of store
    .prepare("SELECT run_id FROM interaction WHERE state='pending'")
    .all() as Array<{ run_id: string }>)
    add(row.run_id);
  const records: DiskRetentionReferences["records"] = [];
  for await (const rows of retentionPages<{
    kind: string;
    runId: string | null;
    state: string;
    finishedAt: string | null;
  }>(store, "command", "kind,run_id AS runId,state,finished_at AS finishedAt")) {
    for (const row of rows) {
      if (row.kind === "product" && row.runId !== null)
        records.push({
          runId: row.runId,
          state: row.state,
          finishedAt: row.finishedAt ?? undefined,
        });
    }
  }
  return {
    isCurrent,
    projectRoots: [...roots],
    registeredProjectRoots,
    protectedProjectRoots,
    referencedRunIds,
    records,
    nativeSessions,
  };
}
