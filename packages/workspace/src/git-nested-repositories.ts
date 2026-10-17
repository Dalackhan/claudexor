import { join } from "node:path";
import { WorkspaceError } from "@claudexor/core";
import { gitEnv } from "./git-run.js";

/** Submodule paths the working tree's own `.gitmodules` declares, relative to
 * the worktree top (where the file lives, whatever directory the capture runs
 * in): a submodule the candidate added on purpose is captured as its commit
 * link, as before. No file, or no declared path, declares nothing. */
async function declaredSubmodulePaths(
  repo: string,
  env: Record<string, string>,
): Promise<Set<string>> {
  const top = await gitEnv(repo, ["rev-parse", "--show-toplevel"], env);
  if (top.code !== 0 || !top.stdout.trim()) return new Set();
  const listed = await gitEnv(
    repo,
    [
      "config",
      "--file",
      join(top.stdout.trim(), ".gitmodules"),
      "--null",
      "--get-regexp",
      "^submodule\\..*\\.path$",
    ],
    env,
  );
  if (listed.code !== 0) return new Set();
  // --null: each entry is "key\nvalue\0", so a path keeps its spaces and newlines.
  return new Set(
    listed.stdout
      .split("\0")
      .filter((entry) => entry.includes("\n"))
      .map((entry) => entry.slice(entry.indexOf("\n") + 1))
      .filter((path) => path.length > 0),
  );
}

/**
 * Untracked nested repositories that no `.gitmodules` entry declares, as
 * worktree-top-relative paths: `git ls-files --others` names each one with a
 * trailing slash because Git never descends into another repository, and
 * `--full-name` keeps the names top-relative when the capture runs in a
 * subdirectory, matching both the patch paths and the `:(top)` exclusions.
 * Read against the caller's scratch index (`env`), so the set is "not in the
 * base tree", never the user's staging state.
 *
 * A patch cannot carry another repository (Git records a commit link, or
 * refuses a repository without a commit outright), so callers leave these out
 * of their `git add` with `nestedRepositoryExcludes` instead of failing.
 */
export async function untrackedNestedRepositories(
  repo: string,
  env: Record<string, string>,
  pathspec: string[],
  label: string,
): Promise<string[]> {
  const listed = await gitEnv(
    repo,
    ["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ...pathspec],
    env,
  );
  if (listed.code !== 0) {
    throw new WorkspaceError(`${label} could not list untracked files: ${listed.stderr.trim()}`);
  }
  const nested = listed.stdout
    .split("\0")
    .filter((entry) => entry.endsWith("/"))
    .map((entry) => entry.slice(0, -1));
  if (nested.length === 0) return [];
  const declared = await declaredSubmodulePaths(repo, env);
  return nested.filter((path) => !declared.has(path));
}

/** Exclusion pathspecs for `untrackedNestedRepositories` paths: top-relative
 * and literal, so a name with glob characters never swallows a sibling. */
export function nestedRepositoryExcludes(paths: string[]): string[] {
  return paths.map((path) => `:(exclude,top,literal)${path}`);
}
