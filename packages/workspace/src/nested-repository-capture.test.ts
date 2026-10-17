import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureWorkingTreeTransient } from "./git.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];

function repository(): { root: string; git: (cwd: string, ...args: string[]) => void } {
  const root = mkdtempSync(join(tmpdir(), "cx-nested-capture-"));
  roots.push(root);
  const git = (cwd: string, ...args: string[]) => {
    execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  };
  git(root, "init", "-q");
  writeFileSync(join(root, "tracked.txt"), "base\n");
  git(root, "add", "tracked.txt");
  git(root, ...identity, "commit", "-qm", "base");
  return { root, git };
}

it("captures the rest of the candidate when untracked folders hold their own repositories", async () => {
  const { root, git } = repository();
  // A repository without a commit makes `git add` refuse outright; one with a
  // commit would become a commit link the patch cannot carry. Both stay out.
  const empty = join(root, ".review-evidence", "no commit yet");
  mkdirSync(empty, { recursive: true });
  git(empty, "init", "-q");
  writeFileSync(join(empty, "probe.txt"), "inside an empty repository\n");
  const committed = join(root, ".review-evidence", "base-copy");
  mkdirSync(committed, { recursive: true });
  git(committed, "init", "-q");
  writeFileSync(join(committed, "copy.txt"), "inside a committed repository\n");
  git(committed, "add", "copy.txt");
  git(committed, ...identity, "commit", "-qm", "copy");
  writeFileSync(join(root, "tracked.txt"), "base\nchanged\n");
  writeFileSync(join(root, "new.txt"), "new file\n");

  const captured = await captureWorkingTreeTransient(root, "HEAD");

  expect(captured.captureIncomplete).toBe(false);
  expect(captured.patch).toContain("+changed");
  expect(captured.patch).toContain("b/new.txt");
  expect(captured.patch).not.toContain(".review-evidence");
  expect(captured.patch).not.toContain("Subproject commit");
  expect(captured.excludedNestedRepositories).toEqual([
    ".review-evidence/base-copy",
    ".review-evidence/no commit yet",
  ]);
});

it("names nothing and keeps every untracked file when no nested repository exists", async () => {
  const { root } = repository();
  mkdirSync(join(root, ".review-evidence", "notes"), { recursive: true });
  writeFileSync(join(root, ".review-evidence", "notes", "log.txt"), "plain evidence\n");

  const captured = await captureWorkingTreeTransient(root, "HEAD");

  expect(captured.captureIncomplete).toBe(false);
  expect(captured.patch).toContain("b/.review-evidence/notes/log.txt");
  expect(captured.excludedNestedRepositories).toBeUndefined();
});

it("keeps a submodule the candidate declares as its commit link", async () => {
  const { root, git } = repository();
  const library = mkdtempSync(join(tmpdir(), "cx-nested-library-"));
  roots.push(library);
  git(library, "init", "-q");
  writeFileSync(join(library, "lib.txt"), "library\n");
  git(library, "add", "lib.txt");
  git(library, ...identity, "commit", "-qm", "library");
  // `git submodule add` clones the repository and declares it in .gitmodules.
  git(
    root,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    library,
    "modules/library",
  );
  const undeclared = join(root, ".review-evidence", "copy");
  mkdirSync(undeclared, { recursive: true });
  git(undeclared, "init", "-q");

  const captured = await captureWorkingTreeTransient(root, "HEAD");

  expect(captured.captureIncomplete).toBe(false);
  expect(captured.patch).toContain("b/.gitmodules");
  expect(captured.patch).toContain("b/modules/library");
  expect(captured.patch).toContain("Subproject commit");
  expect(captured.excludedNestedRepositories).toEqual([".review-evidence/copy"]);
});
