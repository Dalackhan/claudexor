import {
  assertCaptureComplete,
  parseUnifiedDiff,
  runCaptureRaw,
  WorkspaceError,
} from "@claudexor/core";

/** BYTE-FAITHFUL git capture: raw buffers, never readline — CR
 * bytes in CRLF diff content survive, and no trailing newline is fabricated
 * (trim-based consumers like revParse are unaffected: git ends its own
 * output with \n). */
export async function git(
  repo: string,
  args: string[],
  input?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await runCaptureRaw("git", ["-C", repo, ...args], {
    timeoutMs: 60_000,
    input,
    windowsConsole: "none",
  });
  assertCaptureComplete(r);
  return r;
}

/** `git` with extra environment (e.g. a scratch GIT_INDEX_FILE for snapshots). */
export async function gitEnv(
  repo: string,
  args: string[],
  env: Record<string, string>,
  input?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await runCaptureRaw("git", ["-C", repo, ...args], {
    timeoutMs: 60_000,
    env,
    input,
    windowsConsole: "none",
  });
  assertCaptureComplete(r);
  return r;
}

/** Capture-time honesty: with --binary a payload-less "Binary files differ"
 * stub should be impossible; if one appears anyway, fail AT CAPTURE with a
 * typed error instead of shipping a patch that cannot apply. */
export function assertNoBinaryStubs(diff: string, label: string): void {
  const stubs = parseUnifiedDiff(diff).files.filter((f) => f.binaryStub);
  if (stubs.length > 0) {
    const names = stubs.map((f) => f.newPath ?? f.oldPath ?? "(unknown)").join(", ");
    throw new WorkspaceError(
      `${label} produced undeliverable binary stub(s) for: ${names}; the work product cannot be applied`,
    );
  }
}
