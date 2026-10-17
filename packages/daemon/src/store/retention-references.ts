import { Session, Thread, ThreadTurn } from "@claudexor/schema";
import type { EngineStore } from "./store.js";
import { decodeBody } from "./thread-rows.js";

export interface DiskRetentionReferences {
  projectRoots: string[];
  protectedProjectRoots: Set<string>;
  referencedRunIds: Set<string>;
  nativeSessions: Map<string, Set<string>>;
  records: Array<{ runId: string; state: string; finishedAt?: string }>;
}

const RetainedTurn = ThreadTurn.omit({ prompt: true });

/** Retirement reads all retained generations, including archived projects. Public
 * listing/admission remains served-generation-only. Any unreadable reference throws. */
export function diskRetentionReferences(
  store: EngineStore,
  ignoreThreadIds: ReadonlySet<string> = new Set(),
): DiskRetentionReferences {
  const roots = new Set(
    (store.prepare("SELECT root FROM project").all() as Array<{ root: string }>).map((r) => r.root),
  );
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
  for (const row of store
    .prepare("SELECT state,body FROM thread WHERE state<>'purged'")
    .all() as Array<{ state: string; body: Uint8Array }>) {
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
      const turn = RetainedTurn.parse(decodeBody(turnRow));
      if (turn.thread_id !== thread.id) throw new Error("retention turn owner disagrees");
      [turn.run_id, turn.parent_run_id, turn.answers_plan_run_id, turn.plan_run_id].forEach(add);
    }
  }
  for (const row of store
    .prepare("SELECT run_id FROM interaction WHERE state='pending'")
    .all() as Array<{ run_id: string }>)
    add(row.run_id);
  const records = (
    store
      .prepare(
        `SELECT run_id AS runId,state,finished_at AS finishedAt
    FROM command WHERE kind='product' AND run_id IS NOT NULL`,
      )
      .all() as Array<{ runId: string; state: string; finishedAt: string | null }>
  ).map((row) => ({
    runId: row.runId,
    state: row.state,
    finishedAt: row.finishedAt ?? undefined,
  }));
  return {
    projectRoots: [...roots],
    protectedProjectRoots,
    referencedRunIds,
    records,
    nativeSessions,
  };
}
