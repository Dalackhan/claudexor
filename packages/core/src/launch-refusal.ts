import { lstatSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { isProvenNonWindowsImage, NOT_WINDOWS_IMAGE } from "./executable-inspection.js";

/** A launch candidate the resolver did not select, and why. */
export interface SkippedLaunchCandidate {
  path: string;
  reason: string;
  /** The provable non-image this candidate would have run (itself, a target, an interpreter). */
  image?: string;
}

/**
 * A launch refused before any process starts, because what the OS would run
 * is provably unable to run there. `code` is the error the spawn itself would
 * report, so callers keep the one spawn-error contract they already handle.
 */
export interface HarnessLaunchRefusal {
  code: "EFTYPE" | "ENOEXEC";
  /** The file the refused launch would have run. */
  path: string;
  message: string;
}

/**
 * A spawn failure caused by the file's format, raised by the OS or by a launch
 * refusal: the same bytes cannot start on a retry. EACCES, a busy file, a
 * missing file or an unknown loader error stay transient for their callers.
 */
export function isExecutableFormatError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return code === "EFTYPE" || code === "ENOEXEC";
}

/** The thrown form, shaped like Node's own spawn error (`code`, `path`). */
export function launchRefusalError(refusal: HarnessLaunchRefusal): Error {
  return Object.assign(new Error(refusal.message), { code: refusal.code, path: refusal.path });
}

/** `path (reason); …` — the one wording of skipped candidates. */
export function describeSkipped(items: readonly SkippedLaunchCandidate[]): string {
  return items.map((item) => `${item.path} (${item.reason})`).join("; ");
}

/**
 * Nothing selected on win32. Spawning the unresolved name hands it to libuv's
 * own search, cwd first, which can reach the very file the resolver rejected.
 * Refuse when that search would reach a provable non-image, or would find
 * nothing while the resolver proved one. Null off win32, and wherever the
 * search stays the OS's: nothing exists (ENOENT), or what it finds is not
 * proven broken.
 */
export function windowsLaunchRefusal(
  bin: string,
  pathValue: string,
  skipped: readonly SkippedLaunchCandidate[],
  platform: NodeJS.Platform,
  cwd: string = process.cwd(),
): HarnessLaunchRefusal | null {
  if (platform !== "win32") return null;
  if (/\.(?:cmd|bat|ps1)$/i.test(bin)) {
    const message = skipped.length
      ? `Cannot launch ${describeSkipped(skipped)}`
      : `Unsupported Windows launcher: ${bin}`;
    return { code: "ENOEXEC", path: bin, message };
  }
  const target = windowsSearchTarget(bin, pathValue, cwd);
  const refused =
    target === null
      ? skipped.find((item) => item.image !== undefined)
      : isProvenNonWindowsImage(target)
        ? (skipped.find((item) => item.path === target) ?? {
            path: target,
            reason: NOT_WINDOWS_IMAGE,
            image: target,
          })
        : undefined;
  if (refused?.image === undefined) return null;
  const listed = [refused, ...skipped.filter((item) => item !== refused)];
  return {
    code: "EFTYPE",
    path: refused.image,
    message: `Cannot launch ${describeSkipped(listed)}`,
  };
}

/**
 * The file libuv's Windows `search_path` (src/win/process.c) gives CreateProcess
 * for `file`. A name with a directory part is looked up only there; a bare name
 * in the cwd first (unless NoDefaultCurrentDirectoryInExePath is set), then in
 * each PATH entry, unquoted and relative to the cwd. Each place tries the
 * literal name when it has an extension, then `.com`, then `.exe`; the first
 * existing non-directory wins and the search stops there.
 */
function windowsSearchTarget(file: string, pathValue: string, cwd: string): string | null {
  const nameAt = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"), file.lastIndexOf(":")) + 1;
  const name = file.slice(nameAt);
  const dot = name.indexOf(".");
  const names = [
    ...(dot >= 0 && dot < name.length - 1 ? [name] : []),
    `${name}.com`,
    `${name}.exe`,
  ];
  const dirs =
    nameAt > 0
      ? [file.slice(0, nameAt)]
      : [
          ...(process.env.NoDefaultCurrentDirectoryInExePath === undefined ? [""] : []),
          ...pathValue
            .split(delimiter)
            .filter(Boolean)
            .map((dir) => dir.replace(/^["']|["']$/g, "")),
        ];
  for (const dir of dirs) {
    for (const candidate of names.map((entry) => resolve(cwd, dir, entry))) {
      try {
        if (!lstatSync(candidate).isDirectory()) return candidate;
      } catch {
        // absent here; libuv moves on to the next name and directory
      }
    }
  }
  return null;
}
