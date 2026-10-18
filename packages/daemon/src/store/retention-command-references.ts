import { RecordedControlRunStartRequest } from "@claudexor/schema";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import { BlobFiles } from "./blob-files.js";
import { retentionPages } from "./retention-pages.js";
import type { EngineStore } from "./store.js";
import type { DiskRetentionReferences } from "./retention-references.js";

// Read the immutable request, not the public summary (which omits retry/plan
// sources). Historical requests need not satisfy today's full run contract.
const Dependencies = RecordedControlRunStartRequest.pick({
  continueFrom: true,
  retryOf: true,
  planRef: true,
  planRunId: true,
}).strip();

/** Every retained command owns its explicit file dependencies, even before it
 * has a run ID. Reading every direct edge also retains the complete ancestor
 * chain, including terminal intermediates and archived generations. */
export async function commandRetentionReferences(store: EngineStore): Promise<{
  records: DiskRetentionReferences["records"];
  referencedRunIds: Set<string>;
}> {
  const blobs = new BlobFiles(store);
  const aliases = new Map<string, string>();
  const referencedRunIds = new Set<string>();
  const records: DiskRetentionReferences["records"] = [];
  for await (const rows of retentionPages<{
    id: string;
    kind: string;
    runId: string | null;
    state: string;
    finishedAt: string | null;
    continue_from: string | null;
    params_sha: string;
  }>(
    store,
    "command",
    "id,kind,run_id AS runId,state,finished_at AS finishedAt,continue_from,params_sha",
  )) {
    for (const row of rows) {
      if (row.kind !== "product") continue;
      await yieldToAdmission();
      const params = Dependencies.parse(JSON.parse(blobs.read(row.params_sha).toString("utf8")));
      if ((params.continueFrom ?? null) !== row.continue_from)
        throw new Error(`command ${row.id} retention predecessor disagrees`);
      for (const id of [row.continue_from, params.retryOf, params.planRef?.runId, params.planRunId])
        if (id) referencedRunIds.add(id);
      if (row.runId !== null) {
        aliases.set(row.id, row.runId);
        records.push({
          runId: row.runId,
          state: row.state,
          finishedAt: row.finishedAt ?? undefined,
        });
      }
    }
  }
  for (const id of referencedRunIds) {
    const runId = aliases.get(id);
    if (runId) referencedRunIds.add(runId);
  }
  return { records, referencedRunIds };
}
