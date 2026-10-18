import { isTerminalLifecycle, RecordedControlRunStartRequest } from "@claudexor/schema";
import { readContinuationSources } from "@claudexor/workspace";
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
type CommandRow = {
  id: string;
  kind: string;
  runId: string | null;
  runDir: string | null;
  state: string;
  finishedAt: string | null;
  continue_from: string | null;
  params_sha: string;
};
const COLUMNS =
  "id,kind,run_id AS runId,run_dir AS runDir,state,finished_at AS finishedAt,continue_from,params_sha";

export async function commandRetentionReferences(
  store: EngineStore,
  referencedRunIds = new Set<string>(),
) {
  const blobs = new BlobFiles(store);
  const aliases = new Map<string, string>();
  const records: DiskRetentionReferences["records"] = [];
  const byRun = new Map<string, (typeof records)[number]>();
  const active = new Set<string>();
  const add = (id: string | null | undefined) => {
    if (!id) return;
    referencedRunIds.add(id);
    const runId = aliases.get(id);
    if (runId) referencedRunIds.add(runId);
  };
  const read = (row: CommandRow) => {
    // Delivery may read source files after awaits, including a repeated
    // apply. Historical delivery params do not reliably name the source.
    if (row.kind === "delivery" && !isTerminalLifecycle(row.state))
      throw new Error("disk retention kept while a delivery command is unsettled");
    if (row.kind !== "product") return;
    if (isTerminalLifecycle(row.state)) active.delete(row.id);
    else active.add(row.id);
    if (row.runDir)
      for (const source of readContinuationSources(row.runDir, { strict: true })) add(source.runId);
    const params = Dependencies.parse(JSON.parse(blobs.read(row.params_sha).toString("utf8")));
    if ((params.continueFrom ?? null) !== row.continue_from)
      throw new Error(`command ${row.id} retention predecessor disagrees`);
    [row.continue_from, params.retryOf, params.planRef?.runId, params.planRunId].forEach(add);
    if (row.runId !== null) {
      aliases.set(row.id, row.runId);
      if (referencedRunIds.has(row.id)) add(row.runId);
      const next = { runId: row.runId, state: row.state, finishedAt: row.finishedAt ?? undefined };
      const previous = byRun.get(row.runId);
      // The pass's lookup retains these objects, so final lifecycle/age checks
      // observe changes without rebuilding a map of the entire command store.
      if (previous) Object.assign(previous, next);
      else {
        records.push(next);
        byRun.set(row.runId, next);
      }
    }
  };
  for await (const rows of retentionPages<CommandRow>(store, "command", COLUMNS)) {
    for (const row of rows) {
      await yieldToAdmission();
      read(row);
    }
  }
  for (const id of referencedRunIds) add(id);
  return {
    records,
    referencedRunIds,
    hasActiveCommands: () => active.size > 0,
    refresh(id: string) {
      const row = store.prepare(`SELECT ${COLUMNS} FROM command WHERE id=?`).get(id) as
        CommandRow | undefined;
      if (!row) return; // Releases are recognized on the next pass.
      // A newly bound run was absent from the pass's original lifecycle map.
      if (row.kind === "product" && row.runId && !byRun.has(row.runId)) add(row.runId);
      read(row);
    },
  };
}
