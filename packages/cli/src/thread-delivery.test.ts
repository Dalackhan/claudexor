import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProjectThreadPort } from "@claudexor/daemon";
import { PR_SECRET_LIKE_REFUSAL } from "@claudexor/delivery";
import { projectRuntimeDir } from "@claudexor/util";
import { ensureThreadWorktree } from "@claudexor/workspace";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { applyThreadDiff } from "./thread-delivery.js";

// While enabled, only the binary inspection read exceeds the capture buffer;
// Git still produces the complete, small binary patch.
const inspection = vi.hoisted(() => ({ overflow: false }));
vi.mock("@claudexor/core", async (original) => {
  const core = await original<typeof import("@claudexor/core")>();
  return {
    ...core,
    runCaptureRaw: (...args: Parameters<typeof core.runCaptureRaw>) =>
      inspection.overflow && args[0] === "git" && args[1][2] === "show"
        ? Promise.reject(new core.CaptureOutputExceeded("stdout"))
        : core.runCaptureRaw(...args),
  };
});

const dirs: string[] = [];
const stores: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  inspection.overflow = false;
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (repo: string, ...args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

/** Assembled at runtime so no secret-shaped literal lives in this file. */
const secret = ["sk", "f".repeat(24)].join("-");
const leakBytes = (kind: "text" | "binary"): Buffer =>
  kind === "text"
    ? Buffer.from(`${secret}\n`)
    : Buffer.concat([Buffer.from([0]), Buffer.from(secret), Buffer.from([0])]);
const leakName = (kind: "text" | "binary"): string => (kind === "text" ? "LEAK.txt" : "LEAK.bin");

/** A committed project with a pushable bare `origin`. */
function projectWithOrigin() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-thread-delivery-")));
  const remote = mkdtempSync(join(tmpdir(), "claudexor-thread-delivery-remote-"));
  dirs.push(repo, remote, projectRuntimeDir(repo));
  execFileSync("git", ["init", "--bare", "-b", "main", remote]);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# test\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=t@t.dev", "-c", "user.name=Test", "commit", "-m", "init");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  return { repo, remote };
}

/** A project with a pushable `origin` and an isolated thread worktree that
 * holds one changed file with secret-like bytes. */
async function threadWithLeak(kind: "text" | "binary") {
  const { repo, remote } = projectWithOrigin();
  const worktree = await ensureThreadWorktree(repo, "thread-1");
  writeFileSync(join(worktree.path, leakName(kind)), leakBytes(kind));
  const thread = {
    workspace: { mode: "isolated", worktree_path: worktree.path, base_sha: worktree.baseSha },
    repo: { root: repo },
    head_run_id: null,
  };
  const threads = {
    getThread: () => thread,
    setThreadWorktree: () => undefined,
  } as unknown as ProjectThreadPort;
  return { repo, remote, threads };
}

describe("thread delivery keeps secret-like bytes local (INV-062)", () => {
  it.each(["text", "binary"] as const)(
    "applies the live %s worktree bytes exactly and advances the durable watermark to them",
    async (kind) => {
      const { repo } = projectWithOrigin();
      const storeRoot = realpathSync(mkdtempSync(join(tmpdir(), "cx-thread-store-")));
      dirs.push(storeRoot);
      const sql = await sqlFixture(storeRoot);
      stores.push(sql);
      // The real daemon thread store is the watermark owner (no port double).
      const threads = sql.graph.threads;
      const thread = threads.createThread({ repoRoot: repo, workspace: "isolated" });
      const worktree = await ensureThreadWorktree(repo, thread.id);
      threads.setThreadWorktree(thread.id, worktree.path, worktree.baseSha);
      threads.bindTurnRun(threads.createTurn(thread.id, "write the file").id, "run-head");
      writeFileSync(join(worktree.path, leakName(kind)), leakBytes(kind));

      const result = await applyThreadDiff(threads, thread.id, { mode: "apply" });

      expect(result).toMatchObject({ applied: true, status: "applied" });
      // The exact bytes the agent wrote arrive in the project, unredacted.
      expect(readFileSync(join(repo, leakName(kind))).equals(leakBytes(kind))).toBe(true);
      // Success durably advances base and delivered-through together, to the
      // delivered project snapshot the persistent branch and worktree now hold.
      const delivered = threads.getThread(thread.id)!.workspace;
      expect(delivered).toMatchObject({
        mode: "isolated",
        worktree_path: worktree.path,
        delivered_through_run_id: "run-head",
      });
      const sha = delivered.base_sha!;
      expect(sha).not.toBe(worktree.baseSha);
      expect(git(repo, "rev-parse", `refs/heads/claudexor/thread-${thread.id}`)).toBe(sha);
      expect(git(worktree.path, "rev-parse", "HEAD")).toBe(sha);
      expect(git(worktree.path, "status", "--porcelain")).toBe("");
      const blob = execFileSync("git", [
        "-C",
        repo,
        "cat-file",
        "blob",
        `${sha}:${leakName(kind)}`,
      ]);
      expect(blob.equals(leakBytes(kind))).toBe(true);
      // The advanced watermark is the next base: nothing is delivered twice.
      await expect(applyThreadDiff(threads, thread.id, { mode: "apply" })).resolves.toMatchObject({
        applied: false,
        status: "empty",
      });
      expect(threads.getThread(thread.id)!.workspace.base_sha).toBe(sha);
    },
  );

  it.each(["text", "binary"] as const)(
    "refuses 'pr' for a %s finding before any branch, commit or push",
    async (kind) => {
      const { repo, remote, threads } = await threadWithLeak(kind);
      const headBefore = git(repo, "rev-parse", "HEAD");
      const branchesBefore = git(repo, "branch", "--list");
      const remoteRefsBefore = git(remote, "for-each-ref");

      const result = await applyThreadDiff(threads, "thread-1", { mode: "pr" });

      expect(result).toMatchObject({ applied: false, status: "rejected", headMoved: false });
      expect(result.detail).toBe(PR_SECRET_LIKE_REFUSAL);
      expect(result.delivery).toMatchObject({ refused: true, treeMutated: false });
      // Refused before the fresh verify: the verifier never ran on this patch.
      expect(result.delivery?.finalVerify).toMatchObject({
        attempted: false,
        reason: "secret_like_patch_not_published",
      });
      // Nothing was created locally and nothing reached the remote.
      expect(existsSync(join(repo, leakName(kind)))).toBe(false);
      expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
      expect(git(repo, "branch", "--list")).toBe(branchesBefore);
      expect(git(remote, "for-each-ref")).toBe(remoteRefsBefore);
    },
  );

  it("refuses 'pr' but applies exactly when a binary payload cannot be inspected", async () => {
    const { repo, remote } = projectWithOrigin();
    const worktree = await ensureThreadWorktree(repo, "thread-1");
    // No secret-like content at all: only its inspection read is refused.
    const bytes = Buffer.concat([Buffer.from([0]), Buffer.alloc(4096, 7)]);
    writeFileSync(join(worktree.path, "large.bin"), bytes);
    const threads = {
      getThread: () => ({
        workspace: { mode: "isolated", worktree_path: worktree.path, base_sha: worktree.baseSha },
        repo: { root: repo },
        head_run_id: null,
      }),
      setThreadWorktree: () => undefined,
    } as unknown as ProjectThreadPort;
    const remoteRefsBefore = git(remote, "for-each-ref");
    inspection.overflow = true;

    const refused = await applyThreadDiff(threads, "thread-1", { mode: "pr" });

    expect(refused).toMatchObject({ applied: false, status: "rejected", headMoved: false });
    expect(refused.detail).toBe(PR_SECRET_LIKE_REFUSAL);
    // The one shared refusal names both causes; it never asks to remove a
    // secret that was not found.
    expect(PR_SECRET_LIKE_REFUSAL).toContain("binary content that could not be inspected");
    expect(PR_SECRET_LIKE_REFUSAL).not.toContain("remove the strings");
    expect(existsSync(join(repo, "large.bin"))).toBe(false);
    expect(git(remote, "for-each-ref")).toBe(remoteRefsBefore);

    const applied = await applyThreadDiff(threads, "thread-1", { mode: "apply" });

    expect(applied).toMatchObject({ applied: true, status: "applied" });
    expect(readFileSync(join(repo, "large.bin")).equals(bytes)).toBe(true);
  });

  it.each(["branch", "commit"] as const)(
    "allows the local '%s' delivery of a secret-like text patch",
    async (mode) => {
      const { repo, remote, threads } = await threadWithLeak("text");
      const remoteRefsBefore = git(remote, "for-each-ref");

      const result = await applyThreadDiff(threads, "thread-1", {
        mode,
        branch: "claudexor/local-delivery",
        message: "local delivery",
      });

      expect(result.applied).toBe(true);
      expect(result.status).toBe(mode === "branch" ? "branched" : "committed");
      expect(git(repo, "show", `${result.delivery?.commit ?? "HEAD"}:LEAK.txt`)).toBe(secret);
      // Local only: the remote is untouched.
      expect(git(remote, "for-each-ref")).toBe(remoteRefsBefore);
    },
  );
});
