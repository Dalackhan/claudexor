import { DeferredMessageDetail, DeferredMessageProjection } from "@claudexor/schema";
import type { EngineStore } from "./store.js";
import type { BlobFiles } from "./blob-files.js";

export interface DeferredMessageRow {
  id: string;
  pid: number;
  predecessor_job_id: string;
  revision: number;
  state: DeferredMessageProjection["state"];
  body_sha: string | null;
  hold: Uint8Array | null;
  successor_job_id: string | null;
  dispatched_revision: number | null;
  created_at: string;
}

/** Compact reads select identities only, never hydrate a command's full result. */
export function deferredMessageProjection(
  store: EngineStore,
  row: DeferredMessageRow,
): DeferredMessageProjection {
  const run = (id: string | null): string | null => {
    if (!id) return null;
    return (
      (
        store.prepare("SELECT run_id FROM command WHERE id=? AND pid=?").get(id, row.pid) as
          { run_id: string | null } | undefined
      )?.run_id ?? null
    );
  };
  const predecessorRunId = run(row.predecessor_job_id);
  return DeferredMessageProjection.parse({
    draftId: row.id,
    revision: row.revision,
    state: row.state,
    predecessorJobId: row.predecessor_job_id,
    predecessorRunId,
    predecessorResult: `/v2/runs/${predecessorRunId ?? row.predecessor_job_id}`,
    hold: row.hold ? JSON.parse(Buffer.from(row.hold).toString("utf8")) : null,
    dispatchedRevision: row.dispatched_revision,
    successorJobId: row.successor_job_id,
    successorRunId: run(row.successor_job_id),
  });
}

/** Full text and controls are addressed reads only. Cleared rows own no body. */
export function deferredMessageDetail(
  store: EngineStore,
  blobs: BlobFiles,
  row: DeferredMessageRow,
): DeferredMessageDetail {
  const content = row.body_sha
    ? JSON.parse(blobs.read(row.body_sha).toString("utf8"))
    : { prompt: "", attachments: [], capturedStart: null };
  return DeferredMessageDetail.parse({ ...deferredMessageProjection(store, row), ...content });
}

/** Cold recovery validates the same decoder and linked identities, never
 * turns a valid row into permission to launch it. */
export function validateDeferredMessages(store: EngineStore, blobs: BlobFiles, pid: number): void {
  const rows = store
    .prepare("SELECT * FROM deferred_message WHERE pid=?")
    .all(pid) as unknown as DeferredMessageRow[];
  for (const row of rows) {
    const detail = deferredMessageDetail(store, blobs, row);
    if (
      !store.prepare("SELECT 1 FROM command WHERE id=? AND pid=?").get(row.predecessor_job_id, pid)
    )
      throw new Error("deferred message predecessor is missing");
    if ((detail.state === "cleared") !== (row.body_sha === null))
      throw new Error("deferred message body custody disagrees with state");
    if ((detail.state === "held") !== (detail.hold !== null) && detail.state !== "cleared")
      throw new Error("deferred message hold disagrees with state");
    if (detail.state === "dispatched") {
      if (
        detail.dispatchedRevision !== detail.revision ||
        !detail.successorJobId ||
        !store.prepare("SELECT 1 FROM command WHERE id=? AND pid=?").get(detail.successorJobId, pid)
      )
        throw new Error("deferred message dispatched receipt is invalid");
    } else if (detail.successorJobId !== null || detail.dispatchedRevision !== null)
      throw new Error("undispatched message carries a successor");
  }
}
