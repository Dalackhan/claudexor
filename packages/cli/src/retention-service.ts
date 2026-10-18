/**
 * Composition of the daemon-owned retention service (W3.6): binds the
 * control-api retention pass to the daemon's live truth — the project
 * registry, thread lineage references, and journal-projected job records —
 * and schedules the bounded startup maintenance pass. `claudexor gc` and the
 * control route are thin callers of the runner built here. The same pass
 * purges expired trash (a trashed thread past `purge_after`) through the one
 * thread purge owner, so trash cannot outlive its restore window forever, and
 * through the same owner finishes every purge whose directory cleanup failed
 * after the purge was journaled.
 */
import type { ProjectThreadPort, ProjectStorePort } from "@claudexor/daemon";
import type { ControlGcReceipt, ControlGcRequest, Thread } from "@claudexor/schema";
import { findActiveThreadRun, runRetentionPass } from "@claudexor/control-api";
import { loadConfig } from "@claudexor/config";
import { claudexorOwnedRoot, noProjectRepoRoot, userConfigDir } from "@claudexor/util";
import { sweepOrphanLanes } from "@claudexor/workspace";
import type { NativeRetentionRequest, NativeRetentionResult } from "./native-home-retention.js";
import { retentionProjects } from "./retention-projects.js";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
export { scheduleStartupRetention } from "./retention-schedule.js";

export interface RetentionRunnerDeps {
  projects: () => ProjectStorePort;
  maxDeletionsPerPass?: number;
  nativeHomes?: (request: NativeRetentionRequest) => Promise<NativeRetentionResult>;
  threads: ProjectThreadPort;
  daemonJobs: () =>
    | Array<{ runId?: string; state: string; finishedAt?: string; params?: unknown }>
    | Promise<Array<{ runId?: string; state: string; finishedAt?: string; params?: unknown }>>;
  /** The ONE thread purge owner (thread-purge.ts): journals the purge, then
   * deletes the isolated worktree/branch and every lane home of the thread. */
  purgeThread: (id: string) => Promise<unknown>;
  /** Whether a directory that owner deletes is still on disk for the thread. */
  hasPurgeLeftovers: (thread: Thread) => boolean;
}

export type RetentionRunner = ((request: ControlGcRequest) => Promise<ControlGcReceipt>) & {
  hasMore?: (receipt?: ControlGcReceipt) => boolean;
};

/** Trashed threads whose restore window (`purge_after`) has ended. */
function expiredTrashThreads(threads: readonly Thread[], now: number): Thread[] {
  return threads.filter(
    (thread) =>
      thread.state === "trashed" &&
      thread.purge_after !== null &&
      Date.parse(thread.purge_after) <= now,
  );
}

/**
 * Finish purges whose directory cleanup failed after the journal commit: a
 * purged thread is hidden from every listing, so without this pass its
 * isolated worktree (and any lane home) would stay on disk forever. The owner
 * journals nothing new for an already purged thread and deletes what is left;
 * a cleanup that fails again is disclosed and retried by the next pass. The
 * thread is never made restorable again. Dry-run only lists them.
 */
async function finishPurgeLeftovers(
  deps: RetentionRunnerDeps,
  threads: readonly Thread[],
  dryRun: boolean,
): Promise<{ finished: string[]; errors: string[] }> {
  const finished: string[] = [];
  const errors: string[] = [];
  for (const thread of threads.filter((thread) => thread.state === "purged")) {
    if (!deps.hasPurgeLeftovers(thread)) continue;
    try {
      if (!dryRun) await deps.purgeThread(thread.id);
      finished.push(thread.id);
    } catch (error) {
      errors.push(
        `purged thread ${thread.id} cleanup: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { finished, errors };
}

/**
 * Purge expired trash through the one purge owner. A thread with a queued or
 * running turn is kept for a later pass (the purge route answers 409
 * `thread_busy` for the same reason); dry-run only lists what it would purge.
 * A purge that fails after its journal commit is finished by the NEXT pass's
 * `finishPurgeLeftovers` (this pass only discloses the error).
 */
async function purgeExpiredTrash(
  deps: RetentionRunnerDeps,
  threads: readonly Thread[],
  dryRun: boolean,
): Promise<{ purged: string[]; errors: string[] }> {
  const purged: string[] = [];
  const errors: string[] = [];
  for (const thread of expiredTrashThreads(threads, Date.now())) {
    const jobs = await deps.daemonJobs();
    // The inventory yielded: a thread may have been restored while its old
    // trash deadline passed. Judge current state immediately before purge.
    const current = deps.threads.getThread(thread.id);
    if (!current || expiredTrashThreads([current], Date.now()).length === 0) continue;
    const active = findActiveThreadRun(jobs, thread.id);
    if (active) {
      errors.push(`expired trash thread ${thread.id} kept: a turn is still ${active.state}`);
      continue;
    }
    try {
      if (!dryRun) await deps.purgeThread(thread.id);
      purged.push(thread.id);
    } catch (error) {
      errors.push(
        `expired trash thread ${thread.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { purged, errors };
}

export function createRetentionRunner(deps: RetentionRunnerDeps): RetentionRunner {
  const noProjectRoot = noProjectRepoRoot();
  // Serialize passes (review sol #7): the startup pass and any concurrent
  // `claudexor gc` / control-op invocation must not interleave rmSync +
  // tombstone writes on the same candidates, which would double-count
  // freed_bytes and cross-report deletions between receipts.
  let inFlight: Promise<ControlGcReceipt> | null = null;
  let lastReceipt: ControlGcReceipt | null = null;
  const truncatedReceipts = new WeakSet<ControlGcReceipt>();
  const runOnce = async (request: ControlGcRequest): Promise<ControlGcReceipt> => {
    // Policy is read fresh per pass (configurable without restart); the
    // reference set spans EVERY non-purged thread's full run lineage.
    let morePending = false;
    const retention = loadConfig(noProjectRoot).global.retention;
    const maintenanceThreads = await deps.threads.retentionThreads();
    // Purges left unfinished by an earlier failure, then expired trash, both
    // FIRST, so the runs only expired trash referenced become ordinary
    // unreferenced candidates of this same pass. A dry run purges nothing, so
    // its reference set skips the would-be-purged threads to preview the same.
    const leftovers = await finishPurgeLeftovers(deps, maintenanceThreads, request.dry_run);
    const trash = await purgeExpiredTrash(deps, maintenanceThreads, request.dry_run);
    const previewPurged = new Set(request.dry_run ? trash.purged : []);
    const references = await deps.threads.retentionReferences(previewPurged);
    try {
      const healthyRoots = new Set(deps.threads.healthyProjectRoots());
      const gcProjects = await retentionProjects(references, noProjectRoot, healthyRoots);
      // Lane sweeping still uses only served healthy roots; archived lanes can
      // belong to retained threads invisible to the public listing.
      const roots = [...healthyRoots, noProjectRoot];
      // INV-034 lifecycle owner (c): remove durable per-lane read-only homes whose
      // thread no longer exists. Bounded to HEALTHY roots only (same fail-closed
      // set as the run GC): a quarantined partition contributes no live thread
      // ids, so its lanes are left untouched until it recovers rather than swept
      // as false orphans. Skip in dry-run — a GC preview must not delete bytes.
      if (!request.dry_run) {
        const liveThreadsByRoot = new Map<string, Set<string>>();
        for (const thread of await deps.threads.retentionThreads()) {
          if (thread.state === "purged") continue;
          const root = thread.repo?.root ?? noProjectRoot;
          (liveThreadsByRoot.get(root) ?? liveThreadsByRoot.set(root, new Set()).get(root)!).add(
            thread.id,
          );
        }
        for (const root of roots) {
          await yieldToAdmission();
          if (!references.isCurrent()) break;
          try {
            sweepOrphanLanes(root, liveThreadsByRoot.get(root) ?? new Set());
          } catch {
            /* best-effort: orphan lane dirs are harmless and re-sweepable */
          }
        }
      }
      const receipt = await runRetentionPass(
        {
          runsMaxAgeDays: retention.runs_max_age_days,
          reviewsMaxAgeDays: retention.reviews_max_age_days,
          keepLastRunsPerProject: retention.keep_last_runs_per_project,
        },
        request,
        {
          projects: () => gcProjects,
          records: () => references.records,
          referencedRunIds: () => references.referencedRunIds,
          referencesCurrent: references.recheck ?? references.isCurrent,
          refreshReferences: references.refresh,
          maxDeletionsPerPass: deps.maxDeletionsPerPass,
          onTruncated: () => {
            morePending = true;
          },
          // Advisory data-root disclosure: the ONE owned-root derivation
          // (claudexorOwnedRoot covers both the default ~/.claudexor tree and
          // an explicit CLAUDEXOR_CONFIG_DIR override) is injected here so the
          // pass itself never reaches for globals. The mode rides along:
          // claudexorOwnedRoot() collapses onto userConfigDir() exactly when a
          // CLAUDEXOR_CONFIG_DIR override is active (in the default mode the
          // owned root is ~/.claudexor while the config dir is its v3 subtree),
          // and the override root owns secrets.json/plugins/quota/workspaces at
          // its top level where the default root does not.
          dataRoot: claudexorOwnedRoot(),
          dataRootMode: claudexorOwnedRoot() === userConfigDir() ? "override" : "default",
        },
      );
      const native = await deps.nativeHomes?.({
        dryRun: request.dry_run,
        olderThan: Date.now() - retention.runs_max_age_days * 24 * 60 * 60_000,
        ignoredRunIds: new Set(
          request.dry_run ? receipt.deleted_runs.map((run) => run.run_id) : [],
        ),
        ignoredThreadIds: previewPurged,
      });
      if (native) {
        receipt.freed_bytes += native.freedBytes;
        receipt.errors.push(...native.errors);
        morePending ||= native.truncated;
        if (request.native_home_report) receipt.native_homes = native.reports;
      }
      receipt.errors.unshift(...leftovers.errors, ...trash.errors);
      if (request.trash_purge_report) {
        receipt.purged_threads = trash.purged;
        receipt.purge_leftovers = leftovers.finished;
      }
      receipt.finished_at = new Date().toISOString();
      if (morePending) truncatedReceipts.add(receipt);
      lastReceipt = receipt;
      return receipt;
    } finally {
      references.close?.();
    }
  };
  const run: RetentionRunner = (request) => {
    const chained = (inFlight ?? Promise.resolve()).then(
      () => runOnce(request),
      () => runOnce(request),
    );
    inFlight = chained;
    return chained.finally(() => {
      if (inFlight === chained) inFlight = null;
    });
  };
  run.hasMore = (receipt = lastReceipt ?? undefined) =>
    receipt !== undefined && truncatedReceipts.has(receipt);
  return run;
}
