/**
 * Host facts told to a harness that runs under a scoped native-state HOME.
 *
 * A scoped HOME selects native state and credentials; it also makes the
 * operator's own caches look absent, which sent models searching the whole
 * home directory for a Playwright browser (the #449 incidents). Two
 * environment facts say what is true instead: the HOME is scoped, and where
 * the operator's home is. The Playwright browser cache is pointed at directly
 * when the operator already has one.
 *
 * Captured from the daemon's UNSCOPED env (`source`, default `process.env`)
 * before HOME/XDG/APPDATA are rebased by the spec env: the operator home is
 * the daemon's home, never the scoped one. Precedence for
 * `PLAYWRIGHT_BROWSERS_PATH`: an explicit value in the operator env (including
 * the special `0`) always wins and is carried so it survives `clean`
 * inheritance; otherwise the operator's cache directory is exported only if
 * ONE stat says it exists; otherwise nothing. A directory stat establishes a
 * location, not an installed compatible browser.
 */
import { statSync } from "node:fs";
import { posix, win32 } from "node:path";

export const HOME_SCOPED_ENV = "CLAUDEXOR_HOME_SCOPED";
export const OPERATOR_HOME_ENV = "CLAUDEXOR_OPERATOR_HOME";
export const PLAYWRIGHT_BROWSERS_PATH_ENV = "PLAYWRIGHT_BROWSERS_PATH";

export interface HostFactsOptions {
  /** The unscoped operator env (the daemon's own); default `process.env`. */
  source?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** One stat per call; injectable for deterministic tests. */
  directoryExists?: (path: string) => boolean;
}

function directoryExistsSync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function operatorHome(source: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const home = platform === "win32" ? source["USERPROFILE"] || source["HOME"] : source["HOME"];
  return home && home.trim() ? home : null;
}

/** The operator's Playwright browser cache location for this platform (one path, no walk). */
export function playwrightCacheDir(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const home = operatorHome(source, platform);
  // Joined with the TARGET platform's separator: the location is handed to a
  // child on that platform, and the facts are computed where the daemon runs.
  const join = platform === "win32" ? win32.join : posix.join;
  if (platform === "win32") {
    const local = source["LOCALAPPDATA"];
    return local && local.trim() ? join(local, "ms-playwright") : null;
  }
  if (platform === "darwin") return home ? join(home, "Library", "Caches", "ms-playwright") : null;
  const xdg = source["XDG_CACHE_HOME"];
  if (xdg && xdg.trim()) return join(xdg, "ms-playwright");
  return home ? join(home, ".cache", "ms-playwright") : null;
}

/**
 * The env patch to ADD on top of a harness spec env. `specEnv` is the patch
 * the run already decided (its scoped HOME, if any); it is never rewritten.
 */
export function harnessHostFactsEnv(
  specEnv: Record<string, string | null | undefined> | undefined,
  options: HostFactsOptions = {},
): Record<string, string> {
  const source = options.source ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.directoryExists ?? directoryExistsSync;
  const out: Record<string, string> = {};
  const home = operatorHome(source, platform);
  const scopedHome = specEnv?.["HOME"];
  // These facts are only true for a session running under a scoped native-state
  // HOME. An in-place run that inherits the operator's own HOME needs none of
  // them (its caches are already in reach), so say nothing.
  if (!scopedHome || !home || scopedHome === home) return out;
  out[HOME_SCOPED_ENV] = "1";
  out[OPERATOR_HOME_ENV] = home;
  // An explicit value already in the spec patch (an embedder or reviewer
  // asking for per-package browsers with `0`, or its own cache) wins over
  // everything: the key is left to the patch as it stands.
  if (specEnv?.[PLAYWRIGHT_BROWSERS_PATH_ENV] !== undefined) return out;
  const explicit = source[PLAYWRIGHT_BROWSERS_PATH_ENV];
  if (explicit !== undefined) {
    // An explicit operator value (including `0` = per-package browsers) wins
    // over the automatic cache and is carried so a `clean` child env keeps it.
    out[PLAYWRIGHT_BROWSERS_PATH_ENV] = explicit;
  } else {
    const cache = playwrightCacheDir(source, platform);
    if (cache && exists(cache)) out[PLAYWRIGHT_BROWSERS_PATH_ENV] = cache;
  }
  return out;
}
