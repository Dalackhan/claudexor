import {
  continuedRunOf,
  continuationPredecessor,
  continuationRefusal,
  continuationRefusalError,
} from "@claudexor/schema";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { JobRecord } from "./job-record.js";

/**
 * Daemon-atomic admission of a `continueFrom` successor (INTERFACES §1). It
 * runs synchronously inside the enqueue RPC immediately before the command is
 * accepted, so the accepted successor command IS the durable claim: journaled
 * before any spawn or adoption, shared by every ingress, and replayed with the
 * command store after a restart. Two concurrent requests are serialized by the
 * RPC loop: exactly one is accepted, the other refused with the chain head.
 */
export function admitContinuationRequest(
  request: unknown,
  records: readonly JobRecord[],
  ancestor: (id: string) => JobRecord | undefined = (id) => continuationPredecessor(id, records),
): unknown {
  const refusal = continuationRefusal(request, records);
  if (refusal) throw continuationRefusalError(refusal);
  // Expiration is committed before asynchronous payload cleanup. A retained
  // directory is no longer evidence, and cannot acquire a new continuation
  // claim after that point. Check ancestors too: fallback can read them later.
  const seen = new Set<string>();
  for (let from = continuedRunOf(request); from && !seen.has(from);) {
    seen.add(from);
    const predecessor = ancestor(from);
    if (predecessor?.runDir) {
      let expired = false;
      try {
        lstatSync(join(predecessor.runDir, "tombstone.yaml"));
        expired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (expired)
        throw Object.assign(new Error(`run ${from} expired by retention`), {
          code: "run_expired_by_retention",
          status: 410,
          retryable: false,
          requiredActions: ["Start a new run; expired evidence cannot be continued."],
        });
    }
    from = continuedRunOf(predecessor?.params);
  }
  return request;
}
