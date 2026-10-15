import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeOutcomeFacts, RunFailure, RunOutcomeFacts, WorkProduct } from "@claudexor/schema";
import type { ArtifactStore } from "@claudexor/artifact-store";

/** Strategy success may already have materialized a WorkProduct before a
 * terminal barrier settles. Reconcile only its terminal projection: produced
 * bytes, review evidence, and apply/revert state remain historical facts. */
export function reconcileWorkProductTerminal(
  context: { store: ArtifactStore; paths: { finalDir: string } },
  facts: RunOutcomeFacts,
): void {
  const path = join(context.paths.finalDir, "work_product.yaml");
  const current = context.store.readYaml<unknown>(path);
  if (!current || typeof current !== "object" || Array.isArray(current)) return;
  const record = current as Record<string, unknown>;
  const priorMeta =
    record["meta"] && typeof record["meta"] === "object" && !Array.isArray(record["meta"])
      ? (record["meta"] as Record<string, unknown>)
      : {};
  const reconciled = {
    ...record,
    meta: {
      ...priorMeta,
      lifecycle: facts.lifecycle,
      outcome_facts: facts,
    },
  };
  WorkProduct.parse(reconciled);
  context.store.writeYaml(path, reconciled);
}

/** Cancellation has no RunFailure payload of its own. A prepared failed result
 * may have written one before the deferred terminal barrier let cancellation
 * win: it is removed — unless it carries capture facts (an incomplete capture
 * whose live or retained source still needs inspection). That record stays on
 * the public failure surface under the cancellation's own category and
 * summary, with no typed code, keeping its phase, capture facts, refs and
 * inspection/manual-cleanup actions. */
export function clearFailureArtifact(
  context: { store: ArtifactStore; paths: { finalDir: string } },
  cancellation: { summary: string },
): void {
  const path = join(context.paths.finalDir, "failure.yaml");
  const current = RunFailure.safeParse(context.store.readYaml<unknown>(path));
  if (!current.success || !current.data.captureFailure) {
    rmSync(path, { force: true });
    return;
  }
  context.store.writeYaml(path, {
    ...current.data,
    category: "cancelled",
    code: null,
    safeMessage: cancellation.summary,
  });
}

/** A failure that replaces a prepared record without a cancellation (a
 * Delegate child drain that failed) leads with its own cause and keeps that
 * record's capture facts, with the record's actions as follow-ups. */
export function preparedCaptureFacts(context: {
  store: ArtifactStore;
  paths: { finalDir: string };
}): { captureFailure?: RunFailure["captureFailure"]; followUps?: string[] } {
  const path = join(context.paths.finalDir, "failure.yaml");
  const current = RunFailure.safeParse(context.store.readYaml<unknown>(path));
  return current.success && current.data.captureFailure
    ? { captureFailure: current.data.captureFailure, followUps: current.data.nextActions }
    : {};
}

/** Replace only the process terminal axes while retaining independent
 * checks/review/no-change/work-state evidence from an already prepared run. */
export function terminalOutcomeFacts(
  prior: RunOutcomeFacts | undefined,
  lifecycle: RunOutcomeFacts["lifecycle"],
  reason: RunOutcomeFacts["reason"],
): RunOutcomeFacts {
  return prior
    ? RunOutcomeFacts.parse({ ...prior, lifecycle, reason })
    : makeOutcomeFacts(lifecycle, { reason });
}
