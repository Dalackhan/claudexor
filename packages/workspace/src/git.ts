import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCaptureComplete, runCaptureRaw, WorkspaceError } from "@claudexor/core";
import { isClaudexorOwnedRuntimePath } from "@claudexor/util";
import {
  initializeGitRepository,
  type EnsureGitRepositoryDependencies,
  type EnsureGitRepositoryResult,
} from "./git-initialization.js";
import {
  nestedRepositoryExcludes,
  untrackedNestedRepositories,
} from "./git-nested-repositories.js";
import { assertNoBinaryStubs, git, gitEnv } from "./git-run.js";
export { git } from "./git-run.js";
export { captureWorkingTreeTransient, diffWorkingTreeTransient } from "./git-transient-capture.js";
export {
  GitBoundaryRootRefusedError,
  GitInitializationError,
  type EnsureGitRepositoryDependencies,
  type EnsureGitRepositoryResult,
} from "./git-initialization.js";

export async function isGitRepo(repo: string): Promise<boolean> {
  const r = await git(repo, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function revParse(repo: string, ref: string): Promise<string> {
  const r = await git(repo, ["rev-parse", ref]);
  if (r.code !== 0) throw new WorkspaceError(`git rev-parse ${ref} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/**
 * Make a project folder usable as a git boundary for write-mode runs.
 *
 * Comparator note: Codex CLI refuses to run outside a git repo (its official
 * quick start is `mkdir && git init && codex`); Claudexor goes one step
 * further and creates the boundary itself, announced via the
 * `project.git.initialized` run event. The baseline commit makes worktree
 * diffs honest from the first run. Runtime is external, so project ignore
 * files are never created or edited as a side effect.
 *
 * The baseline commit is authored as "Claudexor" deterministically — it is a
 * tool-created commit and must not depend on (or pollute) user git identity.
 */
export async function ensureGitRepository(
  repo: string,
  dependencies: EnsureGitRepositoryDependencies = {},
): Promise<EnsureGitRepositoryResult> {
  return initializeGitRepository(
    repo,
    dependencies.runGit ?? git,
    dependencies.probeCapability,
    dependencies.rootPolicy,
  );
}

export async function statusPorcelain(repo: string): Promise<string> {
  return (await git(repo, ["status", "--porcelain"])).stdout;
}

/**
 * Capture the full dirty working tree (tracked AND untracked) as a dangling
 * commit; null if clean. Plain `git stash create` captures only TRACKED
 * changes, silently dropping the user's new-but-unstaged files from the run's
 * base. We instead seed a scratch index from HEAD, `add -A` into it (which
 * respects .gitignore, so run artifacts stay out), and commit-tree the result.
 */
export async function stashCreate(repo: string): Promise<string | null> {
  // NUL form is filename-faithful (newlines, quotes and whitespace are legal
  // path bytes). Runtime is external, so every reported path is user state.
  const status = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.code !== 0)
    throw new WorkspaceError(`snapshot status failed: ${status.stderr.trim()}`);
  if (status.stdout.length === 0) return null;
  const head = await git(repo, ["rev-parse", "HEAD"]);
  if (head.code !== 0)
    throw new WorkspaceError(`snapshot rev-parse HEAD failed: ${head.stderr.trim()}`);
  const headSha = head.stdout.trim();
  // Unique per call: concurrent envelope creates (a best_of_n wave) must never
  // collide on the scratch index (same pid + same millisecond is real). It lives
  // in the OS temp dir, NOT under `<repo>/.git` — in a linked worktree `.git` is
  // a FILE (gitdir pointer), so a scratch path there fails (review #8).
  const scratchDir = mkdtempSync(join(tmpdir(), "claudexor-snapshot-index-"));
  const tmpIndex = join(scratchDir, "index");
  const env: Record<string, string> = {
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: "Claudexor",
    GIT_AUTHOR_EMAIL: "noreply@claudexor.local",
    GIT_COMMITTER_NAME: "Claudexor",
    GIT_COMMITTER_EMAIL: "noreply@claudexor.local",
  };
  try {
    const read = await gitEnv(repo, ["read-tree", "HEAD"], env);
    if (read.code !== 0)
      throw new WorkspaceError(`snapshot read-tree failed: ${read.stderr.trim()}`);
    // Bare add runs only against the scratch index. It respects the project's
    // own ignore policy without changing the live index. `.claudexor/` is not a
    // runtime exception in v2: tracked or untracked project config is user state.
    // An undeclared nested repository stays out, as in the candidate capture:
    // `add` refuses one without a commit and would freeze one with a commit as
    // a commit link (`:/` keeps the whole-tree scope of the bare add).
    const nested = await untrackedNestedRepositories(repo, env, [":/"], "snapshot");
    const add = await gitEnv(
      repo,
      ["add", "-A", ...(nested.length ? ["--", ":/", ...nestedRepositoryExcludes(nested)] : [])],
      env,
    );
    if (add.code !== 0) throw new WorkspaceError(`snapshot add -A failed: ${add.stderr.trim()}`);
    const writeTree = await gitEnv(repo, ["write-tree"], env);
    if (writeTree.code !== 0)
      throw new WorkspaceError(`snapshot write-tree failed: ${writeTree.stderr.trim()}`);
    const tree = writeTree.stdout.trim();
    const commit = await gitEnv(
      repo,
      [
        "commit-tree",
        tree,
        "-p",
        headSha,
        "-m",
        "claudexor: dirty worktree snapshot (incl. untracked)",
      ],
      env,
    );
    if (commit.code !== 0)
      throw new WorkspaceError(`snapshot commit-tree failed: ${commit.stderr.trim()}`);
    const sha = commit.stdout.trim();
    return sha.length > 0 ? sha : null;
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      /* scratch index cleanup is best-effort */
    }
  }
}

/**
 * Capture the CURRENT working-tree state (tracked + untracked, minus `.claudexor`)
 * as a commit sha — always returns one. Dirty trees become a dangling snapshot
 * commit (via `stashCreate`); a clean tree resolves to HEAD. This is the per-turn
 * diff base for in-place threads: snapshot at turn start, snapshot at turn end,
 * `diffTrees(base, end)` yields exactly that turn's net change (pre-existing dirty
 * state is folded into `base`, so the reviewer never sees prior turns' edits).
 */
export async function snapshotTree(repo: string): Promise<string> {
  const snap = await stashCreate(repo);
  return snap ?? (await revParse(repo, "HEAD"));
}

/** Net diff between two tree-ish shas (used for in-place per-turn diffs).
 * `--binary`: binary changes carry an APPLYABLE payload instead of
 * degrading to a "Binary files differ" stub that silently loses the work. */
export async function diffTrees(repo: string, baseSha: string, endSha: string): Promise<string> {
  const r = await git(repo, ["diff", "--binary", baseSha, endSha]);
  if (r.code !== 0) {
    throw new WorkspaceError(`git diff ${baseSha} ${endSha} failed: ${r.stderr.trim()}`);
  }
  assertNoBinaryStubs(r.stdout, `git diff ${baseSha} ${endSha}`);
  return r.stdout;
}

/**
 * Materialize a patch against an exact base in a scratch index and return the
 * resulting tree id. The live index and worktree are never consulted or
 * changed. Commit-class delivery uses this as its expected candidate tree so a
 * concurrently staged user path can never be swept into a Claudexor commit.
 */
export async function materializePatchTree(
  repo: string,
  baseSha: string,
  diff: string,
): Promise<string> {
  const scratchDir = mkdtempSync(join(tmpdir(), "claudexor-patch-index-"));
  const indexPath = join(scratchDir, "index");
  const env = { GIT_INDEX_FILE: indexPath, GIT_OPTIONAL_LOCKS: "0" };
  try {
    const read = await gitEnv(repo, ["read-tree", baseSha], env);
    if (read.code !== 0) {
      throw new WorkspaceError(
        `git read-tree ${baseSha} failed during patch materialization: ${read.stderr.trim()}`,
      );
    }
    if (diff.trim()) {
      const applied = await gitEnv(
        repo,
        ["apply", "--cached", "--whitespace=nowarn", "-"],
        env,
        diff,
      );
      if (applied.code !== 0) {
        throw new WorkspaceError(
          `scratch git apply failed during patch materialization: ${applied.stderr.trim()}`,
        );
      }
    }
    const written = await gitEnv(repo, ["write-tree"], env);
    if (written.code !== 0) {
      throw new WorkspaceError(`scratch git write-tree failed: ${written.stderr.trim()}`);
    }
    return written.stdout.trim();
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      /* scratch index cleanup is best-effort */
    }
  }
}

export async function worktreeAdd(
  repo: string,
  path: string,
  branch: string,
  baseSha: string,
): Promise<void> {
  const r = await git(repo, ["worktree", "add", "-b", branch, path, baseSha]);
  if (r.code !== 0) throw new WorkspaceError(`git worktree add failed: ${r.stderr.trim()}`);
}

/** Disposable candidate checkout with private refs/index/objects. The source
 * repository is only an object alternate, so harness `git add`/`commit` cannot
 * write candidate blobs or refs into the user's repository. */
export async function isolatedCloneAdd(
  repo: string,
  path: string,
  branch: string,
  baseSha: string,
): Promise<void> {
  const cloned = await runCaptureRaw(
    "git",
    ["clone", "--shared", "--no-checkout", "--", repo, path],
    { timeoutMs: 120_000 },
  );
  assertCaptureComplete(cloned);
  if (cloned.code !== 0) {
    throw new WorkspaceError(`isolated clone failed: ${cloned.stderr.trim()}`);
  }
  const checkout = await git(path, ["checkout", "-b", branch, baseSha]);
  if (checkout.code !== 0) {
    throw new WorkspaceError(`isolated clone checkout failed: ${checkout.stderr.trim()}`);
  }
  const detachedRemote = await git(path, ["remote", "remove", "origin"]);
  if (detachedRemote.code !== 0) {
    throw new WorkspaceError(
      `isolated clone remote removal failed: ${detachedRemote.stderr.trim()}`,
    );
  }
}

/** Recreate a worktree for an EXISTING branch (recovery: dir lost, branch survived). */
export async function worktreeAddExisting(
  repo: string,
  path: string,
  branch: string,
): Promise<void> {
  // A stale registration for the lost directory would fail the add, so it has
  // to go — but ONLY it. `git worktree prune` is repo-wide (see worktreePrune)
  // and would take a co-writer's momentarily-absent tree of the same git dir
  // with it; this recovery runs against the USER'S project root, so that is
  // exactly the shared git dir. Deregistering the one path we are about to
  // recreate is the whole need.
  await worktreeRemove(repo, path);
  const r = await git(repo, ["worktree", "add", path, branch]);
  if (r.code !== 0)
    throw new WorkspaceError(`git worktree add (existing branch) failed: ${r.stderr.trim()}`);
}

export async function worktreeRemove(repo: string, path: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", path]);
}

/**
 * Apply a unified diff to a tree with a 3-way merge (race-winner adoption into
 * the live in-place tree). Throws loudly on conflict so the caller can disclose
 * `adopted:false` and offer a manual apply — the work is never silently lost.
 */

export interface ProtectedApplyResult {
  ok: boolean;
  /** True when the tree does NOT match its pre-apply state (restore failed). */
  treeMutated: boolean;
  detail?: string;
}

async function runProtectedApply(
  repo: string,
  diff: string,
  options: { index: boolean; reverse: boolean },
): Promise<ProtectedApplyResult> {
  if (!diff.trim()) return { ok: true, treeMutated: false, detail: "empty patch; no-op" };
  const flags = [
    "apply",
    ...(options.index ? ["--index"] : []),
    ...(options.reverse ? ["--reverse"] : []),
    "--whitespace=nowarn",
  ];
  const check = await git(repo, [...flags, "--check", "-"], diff);
  if (check.code !== 0) {
    return {
      ok: false,
      // A refused forward apply has not touched the tree. A refused reverse
      // means the Claudexor-written postimage could not be removed exactly and
      // therefore remains a mutation that must be surfaced to the operator.
      treeMutated: options.reverse,
      detail: `${options.reverse ? "reverse " : ""}apply --check refused: ${check.stderr.trim()}`,
    };
  }
  const before = await statusPorcelain(repo);
  const applied = await git(repo, [...flags, "-"], diff);
  if (applied.code === 0) {
    return {
      ok: true,
      // Forward apply introduces the patch; reverse apply removes it.
      treeMutated: !options.reverse,
    };
  }
  const after = await statusPorcelain(repo);
  const unchanged = after === before;
  return {
    ok: false,
    treeMutated: options.reverse ? true : !unchanged,
    detail:
      `${options.reverse ? "reverse " : ""}apply failed after preflight: ${applied.stderr.trim()}` +
      (unchanged
        ? "; tree and index remain at the observed pre-operation state"
        : "; target changed during apply; no destructive rollback was attempted"),
  };
}

/**
 * The protected apply path deliberately does not use `--3way`: 3-way failures
 * may leave conflict stages and historically triggered a destructive
 * `checkout -- .` rollback. Plain `git apply` is all-or-nothing unless
 * `--reject` is requested (we never request it). A stale/concurrent target is
 * refused; no automatic rollback ever overwrites user state.
 */
export async function applyPatchProtected(
  repo: string,
  diff: string,
): Promise<ProtectedApplyResult> {
  return runProtectedApply(repo, diff, { index: false, reverse: false });
}

/**
 * Commit-class delivery updates the worktree and index as one Git operation.
 * `git apply --index` refuses when either preimage diverged and does not sweep
 * unrelated paths into the index.
 */
export async function applyPatchAndIndexProtected(
  repo: string,
  diff: string,
): Promise<ProtectedApplyResult> {
  return runProtectedApply(repo, diff, { index: true, reverse: false });
}

/**
 * Remove only an exact Claudexor-written patch postimage from worktree+index.
 * This is the sole post-apply compensation path: no reset, checkout, or
 * path-blind deletion is permitted. Concurrent overlapping edits make the
 * reverse check fail and are preserved for an explicit recovery decision.
 */
export async function reversePatchAndIndexProtected(
  repo: string,
  diff: string,
): Promise<ProtectedApplyResult> {
  return runProtectedApply(repo, diff, { index: true, reverse: true });
}

/** Registered worktree paths of `repo` (main tree first), from porcelain output. */
async function worktreeList(repo: string): Promise<string[]> {
  const r = await git(repo, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter((path) => path.length > 0);
}

/**
 * Prune stale worktree registrations — but ONLY when every stale one is ours.
 *
 * `git worktree prune` is REPO-WIDE: it deregisters every worktree whose
 * directory is missing at that instant, across the whole shared git dir. When
 * another writer drives Claudexor from its own worktrees of the same
 * repository, a tree of theirs that is momentarily absent (being recreated, on
 * an unmounted volume) is indistinguishable from dead debris — and pruning it
 * silently unregisters someone else's live workspace. Claudexor's own envelope
 * trees live under the Claudexor runtime root, so that is the whole test.
 *
 * Leaving OUR stale admin entry behind is cheap (it costs a directory under
 * `.git/worktrees` until a prune is safe again, and a caller that must reuse
 * one exact name deregisters that one path with `worktreeRemove`).
 * Deregistering a worktree we do not own is not recoverable by us at all.
 * Refusing is the honest trade.
 *
 * This is the ONLY place in the tree that runs the repo-wide `worktree prune`;
 * a second ungated caller re-opens the whole harm, so keep it that way.
 */
export async function worktreePrune(repo: string): Promise<void> {
  for (const path of await worktreeList(repo)) {
    if (existsSync(path) || isClaudexorOwnedRuntimePath(path)) continue;
    return;
  }
  await git(repo, ["worktree", "prune"]);
}

/** Delete a local branch (best-effort GC of per-attempt claudexor/* branches). */
export async function branchDelete(repo: string, branch: string): Promise<void> {
  await git(repo, ["branch", "-D", branch]);
}
