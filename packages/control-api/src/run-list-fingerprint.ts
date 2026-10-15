import { statSync } from "node:fs";
import { sha256 } from "@claudexor/util";
import {
  ENVELOPE_CUSTODY_FILE,
  RETAINED_ENVELOPE_POINTER,
  readContinuationSources,
  retainedEnvelopeBase,
} from "@claudexor/workspace";
import { safeArtifactPath } from "./artifact-paths.js";
import type { DaemonRunRecord } from "./run-record.js";
import { TERMINAL_STATES } from "./sse-shared.js";

/** Number of artifact-path probes performed by the run-list fingerprinter. */
let fingerprintProbeCount = 0;
export function runListFingerprintProbeCountForTests(): number {
  return fingerprintProbeCount;
}
export function resetRunListFingerprintProbeCountForTests(): void {
  fingerprintProbeCount = 0;
}

type Dependency = { root: string; rel: string; identity: string };
export type RunListFingerprint = {
  record: string;
  dependencies: Dependency[];
  value: string;
};

function fileIdentity(root: string, rel: string): string {
  fingerprintProbeCount++;
  const path = safeArtifactPath(root, rel);
  if (!path) return "0";
  try {
    const stat = statSync(path, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch {
    return "0";
  }
}

/** The LRU entry owns its discovered dependencies. An unchanged poll only stats
 * that fixed set; any change rebuilds all pointer/custody addresses, including
 * missing files and ancestors beyond the first currently retained envelope. */
export function summaryFingerprint(
  rec: DaemonRunRecord,
  previous?: RunListFingerprint,
): RunListFingerprint {
  const record = JSON.stringify([
    rec.runDir,
    rec.state,
    paramsFingerprint(rec),
    rec.finishedAt ?? "",
    rec.error ?? "",
  ]);
  if (
    previous?.record === record &&
    previous.dependencies.every((dep) => fileIdentity(dep.root, dep.rel) === dep.identity)
  )
    return previous;

  const dependencies: Dependency[] = [];
  const addresses = new Set<string>();
  const remember = (root: string, rel: string): void => {
    const key = JSON.stringify([root, rel]);
    if (!addresses.has(key)) {
      addresses.add(key);
      dependencies.push({ root, rel, identity: fileIdentity(root, rel) });
    }
  };
  if (rec.runDir) {
    const local = TERMINAL_STATES.has(rec.state)
      ? []
      : [
          "events.jsonl",
          "context/task.yaml",
          "final/structured_output.yaml",
          "arbitration/decision.yaml",
          "final/telemetry.yaml",
          "final/run_facts.yaml",
          "final/failure.yaml",
          "final/summary.md",
          "final/answer.md",
          "final/plan.md",
          "final/explore.md",
          "final/report.md",
          "final/patch.diff",
          "final/work_product.yaml",
        ];
    for (const rel of [
      ...local,
      "final/delivery_state.yaml",
      "tombstone.yaml",
      "context/continuation.json",
    ])
      remember(rec.runDir, rel);
    // Stat before parsing: a concurrent replacement must invalidate the next poll.
    const roots = new Set([
      rec.runDir,
      ...readContinuationSources(rec.runDir).map((s) => s.runDir),
    ]);
    for (const root of roots) {
      if (root !== rec.runDir) {
        // GC can reclaim a standalone ancestor without any envelope pointer.
        // Root identity also covers deletion when publishing the tombstone fails.
        remember(root, ".");
        remember(root, "tombstone.yaml");
      }
      remember(root, RETAINED_ENVELOPE_POINTER);
      const base = retainedEnvelopeBase(root);
      if (base !== null) remember(base, ENVELOPE_CUSTODY_FILE);
    }
  }
  return { record, dependencies, value: JSON.stringify([record, dependencies]) };
}

function paramsFingerprint(rec: DaemonRunRecord): string {
  try {
    return sha256(JSON.stringify(rec.params ?? null));
  } catch {
    return "unserializable-params";
  }
}
