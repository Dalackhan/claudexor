import { Session, Thread, ThreadTurn } from "@claudexor/schema";
import type { EngineStore } from "./store.js";
import { decodeBody } from "./thread-rows.js";

const RetainedTurn = ThreadTurn.omit({ prompt: true });
type Body = { body: Uint8Array };
type ThreadRow = Body & { state: string };
type SessionRow = Body & { harness_id: string; thread_id: string };
type TurnRow = Body & { thread_id: string };

/** One typed reader for the initial inventory AND changed-owner rechecks.
 * Protection only grows during a pass; release is recognized by the next pass. */
export class RetentionReferenceReader {
  readonly runs = new Set<string>();
  readonly sessions = new Map<string, Set<string>>();
  readonly roots = new Set<string>();

  constructor(
    private readonly store: EngineStore,
    private readonly ignored: ReadonlySet<string>,
  ) {}

  add = (id: string | null | undefined) => {
    if (id) this.runs.add(id);
  };

  thread(row: ThreadRow): Thread | undefined {
    if (row.state === "purged") return;
    const thread = Thread.parse(decodeBody(row));
    if (thread.state !== row.state)
      throw new Error(`thread ${thread.id} retention state disagrees`);
    if (thread.repo) this.roots.add(thread.repo.root);
    if (this.ignored.has(thread.id) && thread.state === "trashed") return;
    thread.run_ids.forEach(this.add);
    this.add(thread.head_run_id);
    return thread;
  }

  turn(row: TurnRow, owner = this.owner(row.thread_id)): void {
    if (!owner) return;
    const turn = RetainedTurn.parse(decodeBody(row));
    if (turn.thread_id !== owner.id) throw new Error("retention turn owner disagrees");
    [turn.run_id, turn.parent_run_id, turn.answers_plan_run_id, turn.plan_run_id].forEach(this.add);
  }

  session(row: SessionRow, owner = this.owner(row.thread_id)): void {
    if (!owner) return;
    const session = Session.parse(decodeBody(row));
    if (session.thread_id !== owner.id || session.harness_id !== row.harness_id)
      throw new Error("native session retention owner disagrees");
    if (session.native_session_id) {
      const ids = this.sessions.get(session.harness_id) ?? new Set<string>();
      ids.add(session.native_session_id);
      this.sessions.set(session.harness_id, ids);
    }
  }

  refresh(table: "thread" | "turn" | "session" | "interaction", id: string): void {
    if (table === "interaction") {
      const row = this.store
        .prepare("SELECT run_id FROM interaction WHERE id=? AND state='pending'")
        .get(id) as { run_id: string } | undefined;
      this.add(row?.run_id);
    } else if (table === "thread") {
      this.owner(id);
    } else if (table === "turn") {
      const row = this.store.prepare("SELECT thread_id,body FROM turn WHERE id=?").get(id) as
        TurnRow | undefined;
      if (row) this.turn(row);
    } else {
      const row = this.store
        .prepare("SELECT thread_id,harness_id,body FROM session WHERE id=?")
        .get(id) as SessionRow | undefined;
      if (row) this.session(row);
    }
  }

  private owner(id: string): Thread | undefined {
    const row = this.store.prepare("SELECT state,body FROM thread WHERE id=?").get(id) as
      ThreadRow | undefined;
    if (!row) return;
    const thread = this.thread(row);
    if (thread && thread.id !== id) throw new Error("retention thread owner disagrees");
    return thread;
  }
}
