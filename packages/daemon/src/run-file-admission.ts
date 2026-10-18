import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { JobRecord } from "./job-record.js";

/** Expiration is irreversible even while its asynchronous cleanup is pending.
 * Called synchronously before a NEW command claim; idempotent receipt replay
 * stays ahead of admission and never revives or requires expired source bytes. */
export function assertUnexpiredRunFiles(
  record: Pick<JobRecord, "id" | "runId" | "runDir"> | undefined,
): void {
  if (!record?.runDir) return;
  try {
    lstatSync(join(record.runDir, "tombstone.yaml"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw Object.assign(new Error(`run ${record.runId ?? record.id} expired by retention`), {
    code: "run_expired_by_retention",
    status: 410,
    retryable: false,
    requiredActions: ["Start a new run; expired evidence cannot be reused."],
  });
}
