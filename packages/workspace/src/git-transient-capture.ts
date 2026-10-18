import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureOutputExceeded, parseUnifiedDiff, WorkspaceError } from "@claudexor/core";
import { containsSecretLikeToken } from "@claudexor/util";
import {
  nestedRepositoryExcludes,
  untrackedNestedRepositories,
} from "./git-nested-repositories.js";
import { assertNoBinaryStubs, git, gitEnv } from "./git-run.js";

/**
 * Capture the current worktree against an exact base without writing its blobs
 * into the user's Git object database. In-place harness output is untrusted
 * until the secret fence has inspected the resulting patch; `snapshotTree`
 * would otherwise leave a dangling raw-secret blob even when artifact
 * persistence later refused the patch.
 *
 * Git still owns filename, mode, symlink, binary, ignored-file, and untracked
 * semantics. A scratch index plus an isolated temporary object directory holds
 * the candidate tree only for the duration of `git diff`; the real object
 * directory is read-only through Git's alternates mechanism.
 */
export interface TransientDiffCapture {
  captureIncomplete: boolean;
  captureFailure?: CaptureOutputExceeded;
  patch: string;
  /** Changed binary files whose pre- or postimage holds secret-like bytes (or
   * could not be read for inspection). The exact patch still carries their
   * payload; a persisted COPY withholds it and discloses these paths (INV-062). */
  binarySecretPaths: string[];
  /** Untracked directories holding their own Git repository. A patch cannot
   * carry another repository (Git would record a commit link, or refuse a
   * repository without a commit), so they are left out of the capture and
   * named here instead of failing the whole capture. */
  excludedNestedRepositories?: string[];
}

export async function captureWorkingTreeTransient(
  repo: string,
  baseSha: string,
  pathExcludes: string[] = [],
): Promise<TransientDiffCapture> {
  const scratchDir = mkdtempSync(join(tmpdir(), "claudexor-transient-diff-"));
  const objectDir = join(scratchDir, "objects");
  const indexPath = join(scratchDir, "index");
  mkdirSync(objectDir, { recursive: true, mode: 0o700 });
  let primaryError: unknown;
  try {
    const actualObjects = await git(repo, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]);
    if (actualObjects.code !== 0 || !actualObjects.stdout.trim()) {
      throw new WorkspaceError(
        `transient diff could not resolve Git objects: ${actualObjects.stderr.trim()}`,
      );
    }
    const env = {
      GIT_INDEX_FILE: indexPath,
      GIT_OBJECT_DIRECTORY: objectDir,
      // Git parses this as a path-list. C-style quoting keeps a legal `:` in a
      // macOS path from becoming a separator (and escapes quotes/backslashes).
      GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(actualObjects.stdout.trim()),
      GIT_OPTIONAL_LOCKS: "0",
    };
    const read = await gitEnv(repo, ["read-tree", baseSha], env);
    if (read.code !== 0) {
      throw new WorkspaceError(`transient diff read-tree failed: ${read.stderr.trim()}`);
    }
    const nested = await untrackedNestedRepositories(
      repo,
      env,
      [".", ...pathExcludes],
      "transient diff",
    );
    const add = await gitEnv(
      repo,
      ["add", "-A", "--", ".", ...pathExcludes, ...nestedRepositoryExcludes(nested)],
      env,
    );
    if (add.code !== 0) {
      throw new WorkspaceError(`transient diff add failed: ${add.stderr.trim()}`);
    }
    const writeTree = await gitEnv(repo, ["write-tree"], env);
    if (writeTree.code !== 0 || !writeTree.stdout.trim()) {
      throw new WorkspaceError(`transient diff write-tree failed: ${writeTree.stderr.trim()}`);
    }
    const diff = await gitEnv(repo, ["diff", "--binary", baseSha, writeTree.stdout.trim()], env);
    if (diff.code !== 0) {
      throw new WorkspaceError(`transient diff failed: ${diff.stderr.trim()}`);
    }
    assertNoBinaryStubs(diff.stdout, `transient git diff ${baseSha}`);
    const flagged = new Set<string>();
    for (const file of parseUnifiedDiff(diff.stdout).files.filter((entry) => entry.binary)) {
      const blobs = [
        ...(!file.added && file.oldPath ? [{ tree: baseSha, path: file.oldPath }] : []),
        ...(!file.deleted && file.newPath
          ? [{ tree: writeTree.stdout.trim(), path: file.newPath }]
          : []),
      ];
      for (const blob of blobs) {
        try {
          const content = await gitEnv(repo, ["show", `${blob.tree}:${blob.path}`], env);
          // An unreadable blob is unprovable, so its payload is withheld too.
          if (content.code === 0 && !containsSecretLikeToken(content.stdout)) continue;
        } catch (error) {
          // A complete compressed patch may carry a much larger blob. Failed
          // inspection withholds that payload, not the already complete patch.
          if (!(error instanceof CaptureOutputExceeded)) throw error;
        }
        flagged.add(file.newPath ?? file.oldPath ?? blob.path);
        break;
      }
    }
    return {
      patch: diff.stdout,
      binarySecretPaths: [...flagged],
      captureIncomplete: false,
      ...(nested.length ? { excludedNestedRepositories: nested } : {}),
    };
  } catch (error) {
    primaryError = error;
    if (error instanceof CaptureOutputExceeded)
      return { patch: "", binarySecretPaths: [], captureIncomplete: true, captureFailure: error };
    throw error;
  } finally {
    // Unlike ordinary best-effort scratch cleanup, this directory may contain
    // a candidate token blob. A cleanup failure is therefore terminal and must
    // never be hidden behind the original capture result.
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch (cleanupError) {
      // A cleanup failure is terminal on its own, but must not erase the typed
      // capture error that explains the primary failure.
      if (primaryError === undefined) {
        const terminal = new WorkspaceError("transient diff scratch cleanup failed", {
          cause: cleanupError,
        });
        Object.defineProperty(terminal, "cleanupError", {
          value: cleanupError,
          enumerable: false,
        });
        throw terminal;
      }
      if (primaryError instanceof Error) {
        try {
          Object.defineProperty(primaryError, "cleanupError", {
            value: cleanupError,
            enumerable: false,
          });
        } catch {
          // A frozen typed error cannot accept cleanup evidence. Preserve both
          // through a wrapper, keeping its machine facts and original cause.
          throw Object.assign(
            new WorkspaceError(primaryError.message, { cause: primaryError }),
            primaryError,
            { cleanupError },
          );
        }
      }
    }
  }
}

export async function diffWorkingTreeTransient(
  repo: string,
  baseSha: string,
  pathExcludes: string[] = [],
): Promise<string> {
  const captured = await captureWorkingTreeTransient(repo, baseSha, pathExcludes);
  if (captured.captureIncomplete) throw captured.captureFailure;
  return captured.patch;
}
