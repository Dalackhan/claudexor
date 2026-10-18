/**
 * Daemon-owned disk retention (W3.6): bounded GC over engine-owned runtime
 * artifacts. Deletes ONLY terminal, unreferenced, non-actionable run trees
 * past their age window — and standalone diff-review trees past theirs —
 * leaving a tombstone projection behind so an old thread fails honestly
 * ("expired by retention"), never a mysterious 404. Every survivor is
 * counted with its keep reason: silent deletion and silent retention are
 * both bugs. The CLI (`claudexor gc`) and the startup maintenance pass are
 * thin callers of this one owner.
 */
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import { dirname, join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import {
  ControlGcReceipt,
  ControlGcRequest,
  type GcKeepCounts,
  type GcRunDeletion,
} from "@claudexor/schema";
import { prunePatchObjects, readTextSafe } from "@claudexor/util";
import { treeReclaimableBytes } from "./retention-bytes.js";
import { ageStampOf, runKeepReason } from "./retention-candidates.js";
import {
  pendingRetirements,
  prepareRetirement,
  RETIRING,
  type Retirement,
} from "./retention-removal.js";

export interface RetentionPolicy {
  runsMaxAgeDays: number;
  reviewsMaxAgeDays: number;
  keepLastRunsPerProject: number;
}

export interface RetentionProject {
  /** Canonical project root (or the no-project root). */
  root: string;
  /** The ArtifactStore runs directory for this root. */
  runsDir: string;
  /** Standalone diff-review trees dir (`<root>/.claudexor/reviews`); null = none. */
  reviewsDir: string | null;
  /** False when inventory proves this namespace has no remaining project owner.
   * Omitted by older embedders preserves their existing keep-last protection. */
  keepLastRuns?: boolean;
}

export interface RetentionRunRecord {
  runId: string;
  state: string;
  finishedAt?: string;
}

type DataRootMode = "default" | "override";

export interface RetentionDeps {
  projects: () => RetentionProject[];
  /** The daemon's journal-projected command records (terminality truth). */
  records: () => RetentionRunRecord[];
  /** Every run id referenced by a non-purged thread (lineage, heads, turns). */
  referencedRunIds: () => Set<string>;
  /** Fresh proof that asynchronous inventory still describes the SQL owners. */
  referencesCurrent?: () => boolean;
  now?: () => number;
  /** Bounded batches: one pass deletes at most this many trees (disclosed). */
  maxDeletionsPerPass?: number;
  /** Signals a real skipped candidate to the lifecycle scheduler. */
  onTruncated?: () => void;
  /**
   * Absolute Claudexor-owned data root to scan for NOT-engine-owned top-level
   * entries (advisory disclosure only — the pass never deletes anything
   * there). Injected from composition, never derived from globals here, so
   * the pass stays a pure function of its deps. Absent = no scan and the
   * receipt field stays absent. The scan also runs ONLY when the request
   * opted in via data_root_report (capability negotiation for version skew).
   */
  dataRoot?: string;
  /**
   * Which layout the injected dataRoot follows — "default" (~/.claudexor,
   * where the engine keeps its state under the v3 generation subtree) or
   * "override" (an explicit CLAUDEXOR_CONFIG_DIR root, which IS the complete
   * relocatable tree, so the engine additionally writes secrets.json,
   * plugins, quota, and workspaces directly at its top level). Injected from
   * composition beside dataRoot; absent defaults to "default".
   */
  dataRootMode?: DataRootMode;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE = "tombstone.yaml";
/**
 * Exact top-level names the engine (or its documented operator surface) owns
 * in BOTH data-root modes. The default root retains these legacy top-level
 * names from pre-generation layouts; an explicit override is itself the
 * complete active root and owns the same direct names. Everything else is
 * foreign debris. Dotfiles are treated as config/service files and omitted.
 */
const COMMON_ROOT_OWNED_ENTRIES = new Set([
  // current engine + documented operator dirs
  "node",
  "profiles",
  "runtime",
  "cache",
  "dogfood",
  "keys",
  "release-authority",
  "planning",
  "remote",
  // legacy engine generations kept as the archive (owner decision, v3.0.0)
  "daemon",
  "projects",
  "native",
  "runs",
  "trust",
  "telemetry",
  // config files
  "config.yaml",
]);
/**
 * Mode-specific owned names. The default root owns the archived v2 generation
 * and active v3 generation. An explicit CLAUDEXOR_CONFIG_DIR override is the
 * complete active tree: it owns direct secrets/plugins/quota/workspaces but no
 * generation children. v1-era data was unversioned directly under the default
 * root, so neither mode owns a `v1` child.
 */
const ROOT_OWNED_ENTRIES_BY_MODE: Record<DataRootMode, ReadonlySet<string>> = {
  default: new Set([...COMMON_ROOT_OWNED_ENTRIES, "v2", "v3"]),
  override: new Set([
    ...COMMON_ROOT_OWNED_ENTRIES,
    "secrets.json",
    "plugins",
    "quota",
    "workspaces",
  ]),
};
/** Owned names the engine expects as plain FILES; every other owned name is a directory. */
const ENGINE_OWNED_FILE_ENTRIES = new Set(["config.yaml", "secrets.json"]);

/**
 * Names of top-level data-root entries the engine does not own (the full
 * sorted list — advisory disclosure, never a deletion surface), classified
 * against the owned set for the injected root mode. An entry whose NAME the
 * engine owns but whose on-disk kind is wrong — a symbolic link of any owned
 * name (dirents are read WITHOUT following links), a non-directory where the
 * engine expects a directory, or a non-file where it expects a plain file —
 * is reported as `<name> (unexpected-kind)`. Throws on an unreadable root —
 * the caller degrades that to an errors[] entry and an ABSENT field, never a
 * misleading empty list and never a failed pass.
 */
async function scanDataRootUnrecognized(dataRoot: string, mode: DataRootMode): Promise<string[]> {
  const owned = ROOT_OWNED_ENTRIES_BY_MODE[mode];
  const report: string[] = [];
  for (const entry of await readdir(dataRoot, { withFileTypes: true })) {
    const name = entry.name;
    if (name.startsWith(".")) continue;
    if (!owned.has(name)) {
      report.push(name);
      continue;
    }
    const kindOk =
      !entry.isSymbolicLink() &&
      (ENGINE_OWNED_FILE_ENTRIES.has(name) ? entry.isFile() : entry.isDirectory());
    if (!kindOk) report.push(`${name} (unexpected-kind)`);
  }
  return report.sort();
}
/** Daemon-record states with an operator or scheduler still attached. */
/**
 * Run states whose tree is COMPLETE and may age out — an explicit allowlist,
 * mirroring ControlRunState's terminal half. A blocklist would fail OPEN: a
 * state added to the enum later (or an unrecognized string from a
 * newer/older daemon's records) would default to deletable, which is exactly
 * the "fail closed on unknown state" contract this service owes. Anything not
 * named here — live, unknown, or future — keeps its tree.
 */
// Terminal set = the ONE projection-owned lifecycle terminals (D8). A
// non-terminal (queued/running) or unrecognized state protects its tree.

export async function runRetentionPass(
  policy: RetentionPolicy,
  request: ControlGcRequest,
  deps: RetentionDeps,
): Promise<ControlGcReceipt> {
  const now = deps.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const dryRun = request.dry_run;
  const maxDeletions = deps.maxDeletionsPerPass ?? 500;
  const runCutoff = now() - policy.runsMaxAgeDays * DAY_MS;
  const reviewCutoff = now() - policy.reviewsMaxAgeDays * DAY_MS;
  const recordsById = new Map(deps.records().map((record) => [record.runId, record]));
  const referenced = deps.referencedRunIds();

  const kept: GcKeepCounts = {
    active: 0,
    recent: 0,
    young: 0,
    referenced: 0,
    actionable: 0,
    unknown_state: 0,
  };
  const projects = [...deps.projects()];
  const deletedRuns: GcRunDeletion[] = [];
  const deletedReviews: { path: string; freed_bytes: number }[] = [];
  const errors: string[] = [];
  let examined = 0;
  let freedBytes = 0;
  const plannedUnlinks = new Map<string, number>();
  let deletions = 0;
  let truncated = false;
  let invalidated = false;
  const proofCurrent = () => {
    if (invalidated) return false;
    try {
      if (deps.referencesCurrent?.() === false) invalidated = true;
    } catch (error) {
      invalidated = true;
      errors.push(`retention reference recheck failed: ${String(error)}`);
    }
    return !invalidated;
  };
  const recoverPending = async (parent: string, kind: "runs" | "reviews", projectRoot: string) => {
    for await (const retirement of pendingRetirements(parent, kind, dryRun, errors)) {
      if (deletions >= maxDeletions) {
        truncated = true;
        break;
      }
      try {
        await retirement.recover();
        const planned = new Map(dryRun ? plannedUnlinks : undefined);
        const bytes = await retirement.reclaimableBytes(planned);
        if (!dryRun) {
          errors.push(...(await retirement.finish()));
        } else for (const [key, value] of planned) plannedUnlinks.set(key, value);
        if (kind === "runs")
          deletedRuns.push({
            run_id: retirement.intent.name,
            project_root: projectRoot,
            freed_bytes: bytes,
          });
        else
          deletedReviews.push({ path: join(parent, retirement.intent.name), freed_bytes: bytes });
        freedBytes += bytes;
        deletions += 1;
      } catch (error) {
        errors.push(`${kind}/${retirement.intent.name}: retired cleanup pending: ${String(error)}`);
      }
    }
  };

  runProjects: for (const project of projects) {
    if (!proofCurrent()) break;
    await recoverPending(project.runsDir, "runs", project.root);
    if (truncated) break;
    const candidates: {
      runId: string;
      root: string;
      ageStamp: number;
      dev: number;
      ino: number;
    }[] = [];
    for (const runId of await listSubdirs(project.runsDir)) {
      await yieldToAdmission();
      if (!proofCurrent()) break runProjects;
      const root = join(project.runsDir, runId);
      if (existsSync(join(root, TOMBSTONE))) continue; // already reclaimed
      examined += 1;
      const record = recordsById.get(runId);
      const reason = runKeepReason(root, runId, record, referenced, runCutoff, (error) =>
        errors.push(`runs/${runId}: kept; its retained sources are unreadable: ${String(error)}`),
      );
      if (reason) {
        kept[reason] += 1;
        continue;
      }
      const ageStamp = ageStampOf(root, record);
      const identity = lstatSync(root);
      if (!identity.isDirectory()) continue;
      candidates.push({ runId, root, ageStamp, dev: identity.dev, ino: identity.ino });
    }
    // Recent history belongs to a still-owned project, not an orphan namespace.
    candidates.sort((a, b) => b.ageStamp - a.ageStamp);
    const keepLast = project.keepLastRuns === false ? 0 : policy.keepLastRunsPerProject;
    const spared = candidates.slice(0, keepLast);
    kept.recent += spared.length;
    for (const candidate of candidates.slice(keepLast)) {
      if (deletions >= maxDeletions) {
        truncated = true;
        break;
      }
      let retirement: Retirement | undefined;
      try {
        const planned = new Map(dryRun ? plannedUnlinks : undefined);
        const bytes = await treeReclaimableBytes(candidate.root, planned);
        if (!dryRun)
          retirement = await prepareRetirement(
            project.runsDir,
            candidate.runId,
            yamlStringify({
              run_id: candidate.runId,
              deleted_at: new Date(now()).toISOString(),
              reason: "retention",
              policy: {
                runs_max_age_days: policy.runsMaxAgeDays,
                keep_last_runs_per_project: policy.keepLastRunsPerProject,
              },
            }),
          );
        if (!proofCurrent()) break runProjects;
        // Re-read every mutable filesystem guard after the asynchronous walk.
        // SQL-backed callers validate their entire snapshot; older embedders
        // without that proof supply fresh references/records here instead.
        const record = deps.referencesCurrent
          ? recordsById.get(candidate.runId)
          : deps.records().find((row) => row.runId === candidate.runId);
        const liveReferences = deps.referencesCurrent ? referenced : deps.referencedRunIds();
        const identity = lstatSync(candidate.root);
        if (
          !identity.isDirectory() ||
          identity.dev !== candidate.dev ||
          identity.ino !== candidate.ino ||
          existsSync(join(candidate.root, TOMBSTONE))
        )
          continue;
        const reason = runKeepReason(
          candidate.root,
          candidate.runId,
          record,
          liveReferences,
          runCutoff,
          (error) =>
            errors.push(
              `runs/${candidate.runId}: kept; its retained sources are unreadable: ${String(error)}`,
            ),
        );
        if (reason) {
          kept[reason] += 1;
          continue;
        }
        if (retirement) {
          retirement.commit();
          errors.push(...(await retirement.finish()));
        }
        if (dryRun) for (const [key, value] of planned) plannedUnlinks.set(key, value);
        deletedRuns.push({
          run_id: candidate.runId,
          project_root: project.root,
          freed_bytes: bytes,
        });
        freedBytes += bytes;
        deletions += 1;
        // Bounded batches must not starve the event loop under the daemon.
        await new Promise<void>((resolve) => setImmediate(resolve));
      } catch (error) {
        errors.push(
          `runs/${candidate.runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        try {
          await retirement?.abandon();
        } catch (error) {
          errors.push(`runs/${candidate.runId}: retirement cleanup: ${String(error)}`);
        }
      }
    }
    // `truncated` is set ONLY where a real candidate was skipped (above), so
    // exhausting the cap on the very last deletable tree never makes the pass
    // claim "run gc again to continue" with nothing left to do.
    if (truncated) break;
  }

  for (const project of projects) {
    await yieldToAdmission();
    if (!proofCurrent()) break;
    // No reviews dir (the no-project root has none) — skip THIS project only.
    // Checked BEFORE the cap so a project with nothing to sweep never makes
    // the pass claim it was truncated.
    if (!project.reviewsDir) continue;
    if (truncated) break;
    // `.claudexor/reviews` lives inside the USER repo: fence the PARENT before
    // ever walking it. A repo that ships `.claudexor` or `.claudexor/reviews`
    // as a symlink must not redirect readdir/rmSync outside the repo (a real
    // rm -rf-outside-repo hole). realpath both the dir and its canonical
    // in-repo location; a mismatch (symlinked parent) skips the whole tree.
    const fenced = canonicalInRepoReviewsDir(project);
    if (fenced.verdict === "missing") continue; // no review debris — clean no-op
    if (fenced.verdict === "unsafe") {
      errors.push(`reviews: ${project.reviewsDir} is not a canonical in-repo directory; skipped`);
      continue;
    }
    const reviewsDir = fenced.path;
    await recoverPending(reviewsDir, "reviews", project.root);
    if (truncated) break;
    for (const name of await listSubdirs(reviewsDir)) {
      // Standalone diff-review trees only — `.claudexor/` in a user repo is
      // user-owned config; the engine deletes nothing there but its own
      // `diff-*` runtime debris, never following a symlinked leaf either.
      if (!name.startsWith("diff-")) continue;
      const path = join(reviewsDir, name);
      let retirement: Retirement | undefined;
      try {
        if (lstatSync(path).isSymbolicLink()) continue;
        if (statSync(path).mtimeMs > reviewCutoff) continue;
        // The cap is checked once this IS a real deletion candidate, so a
        // truncation disclosure always means work was genuinely left behind.
        if (deletions >= maxDeletions) {
          truncated = true;
          break;
        }
        const planned = new Map(dryRun ? plannedUnlinks : undefined);
        const bytes = await treeReclaimableBytes(path, planned);
        if (!dryRun) retirement = await prepareRetirement(reviewsDir, name, null);
        if (!proofCurrent()) break;
        const currentFence = canonicalInRepoReviewsDir(project);
        if (
          currentFence.verdict !== "ok" ||
          currentFence.path !== reviewsDir ||
          !lstatSync(path).isDirectory() ||
          statSync(path).mtimeMs > reviewCutoff
        )
          continue;
        if (retirement) {
          retirement.commit();
          errors.push(...(await retirement.finish()));
        }
        if (dryRun) for (const [key, value] of planned) plannedUnlinks.set(key, value);
        deletedReviews.push({ path, freed_bytes: bytes });
        freedBytes += bytes;
        deletions += 1;
        // Same bounded-batch discipline as the runs loop: yield so a large
        // reviews sweep never blocks the daemon's event loop.
        await new Promise<void>((resolve) => setImmediate(resolve));
      } catch (error) {
        errors.push(`reviews/${name}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        try {
          await retirement?.abandon();
        } catch (error) {
          errors.push(`reviews/${name}: retirement cleanup: ${String(error)}`);
        }
      }
    }
  }
  if (truncated) {
    deps.onTruncated?.();
    errors.push(
      `pass truncated at ${maxDeletions} deletions (bounded batch); run gc again to continue`,
    );
  }
  if (invalidated) {
    deps.onTruncated?.();
    errors.push(
      "retention references changed during inventory; remaining candidates kept; retry with a fresh snapshot",
    );
  }

  for (const project of projects) {
    try {
      if (invalidated) break;
      freedBytes += await prunePatchObjects(dirname(project.runsDir), dryRun, plannedUnlinks);
    } catch (error) {
      errors.push(`patch objects: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Advisory data-root disclosure (never a deletion surface): a failed scan
  // leaves the field ABSENT — an empty list must always mean "scanned, clean".
  // Emitted ONLY when the request opted in via data_root_report: a request
  // from a client that never sent the flag (any pre-feature CLI) gets a
  // receipt byte-compatible with pre-feature engines, so an old strict
  // receipt schema never rejects the reply to a mutating verb it already ran.
  let dataRootUnrecognized: string[] | undefined;
  if (request.data_root_report === true && deps.dataRoot) {
    try {
      dataRootUnrecognized = await scanDataRootUnrecognized(
        deps.dataRoot,
        deps.dataRootMode ?? "default",
      );
    } catch (error) {
      errors.push(
        `data root scan (${deps.dataRoot}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return ControlGcReceipt.parse({
    schema_version: 1,
    dry_run: dryRun,
    started_at: startedAt,
    finished_at: new Date(now()).toISOString(),
    policy: {
      runs_max_age_days: policy.runsMaxAgeDays,
      reviews_max_age_days: policy.reviewsMaxAgeDays,
      keep_last_runs_per_project: policy.keepLastRunsPerProject,
    },
    examined_runs: examined,
    deleted_runs: deletedRuns,
    kept,
    deleted_reviews: deletedReviews,
    freed_bytes: freedBytes,
    errors,
    ...(dataRootUnrecognized === undefined ? {} : { data_root_unrecognized: dataRootUnrecognized }),
  });
}

export interface RunTombstone {
  run_id: string;
  deleted_at: string;
  reason: string;
}

/** The honest post-GC projection: why this run's artifacts are gone. */
export function readRunTombstone(runDir: string): RunTombstone | null {
  const text = readTextSafe(join(runDir, TOMBSTONE));
  if (text === null) return null;
  try {
    const value = yamlParse(text) as Partial<RunTombstone> | null;
    return value && typeof value.run_id === "string" && typeof value.deleted_at === "string"
      ? { run_id: value.run_id, deleted_at: value.deleted_at, reason: String(value.reason ?? "") }
      : null;
  } catch {
    return null;
  }
}

/**
 * The reviews dir ONLY if it is a real in-repo directory: its canonical
 * (symlink-resolved) path must equal the canonical `<repo>/.claudexor/reviews`
 * built from the canonical repo root. A symlinked `.claudexor` or
 * `.claudexor/reviews` (committed by a hostile/misconfigured repo) resolves
 * elsewhere — the engine never rm -rf's outside the repo it was pointed at.
 * "Missing" is a distinct verdict: MOST projects have no review debris, and
 * reporting them as unsafe would put a false error in every pass receipt
 * (final sol review #7).
 */
function canonicalInRepoReviewsDir(
  project: RetentionProject,
): { verdict: "ok"; path: string } | { verdict: "missing" } | { verdict: "unsafe" } {
  if (!project.reviewsDir || !existsSync(project.reviewsDir)) return { verdict: "missing" };
  try {
    const canonicalRoot = realpathSync(project.root);
    const expected = join(canonicalRoot, ".claudexor", "reviews");
    const actual = realpathSync(project.reviewsDir);
    return actual === expected ? { verdict: "ok", path: actual } : { verdict: "unsafe" };
  } catch {
    return { verdict: "unsafe" };
  }
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== RETIRING)
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
