/**
 * The process context every harness install/maintenance step runs in: the
 * HOME-anchored prefix, the runner Node and its embedded npm, and the clean
 * vendor-child environment. One producer for the installer, the post-install
 * proof and maintenance inspection, so they can never disagree about which
 * prefix or PATH they read.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  composeBaseEnv,
  embeddedNpmCli,
  pickAllowlistedEnv,
  WINDOWS_RUNTIME_ENV_KEYS,
} from "@claudexor/core";
import type { InstallProofRuntime } from "./harness-install-proof.js";
import type { HarnessInstallTarget } from "./harness-install-recipes.js";

export interface InstallerRuntimeOptions {
  home?: string;
  nodePath?: string;
  /** Explicit install layout. Omitted preserves the historical remote target. */
  target?: HarnessInstallTarget;
  spawn?: typeof spawnSync;
  platform?: NodeJS.Platform;
  /** The runner Node's architecture (npm selects the platform package by it). */
  arch?: string;
  /** Test/integration source before the clean allowlist and target-aware PATH
   * normalization are applied. Provider credentials are still scrubbed. */
  sourceEnv?: NodeJS.ProcessEnv;
}

export interface InstallerRuntime extends InstallProofRuntime {
  home: string;
  target: HarnessInstallTarget;
}

/** The runner's bundled npm entrypoint must exist before any npm child runs.
 * Its absence is a LOCAL fault: no registry retry or other version helps. */
export function embeddedNpmProblem(
  runtime: Pick<InstallerRuntime, "runnerNodePath" | "platform">,
  exists: (path: string) => boolean = existsSync,
): { code: "embedded_npm_missing"; message: string } | null {
  const npmCLI = embeddedNpmCli(runtime.runnerNodePath, runtime.platform);
  if (exists(npmCLI)) return null;
  return {
    code: "embedded_npm_missing",
    message: `the bundled npm entrypoint is missing at ${npmCLI} (expected inside the pinned Node runtime next to this CLI)`,
  };
}

export function installerRuntime(options: InstallerRuntimeOptions = {}): InstallerRuntime {
  // Anchored on the SAME `HOME` the harness PATH producer reads, so the prefix
  // this installs into is the prefix doctor/login/run resolve — on Windows
  // `homedir()` follows USERPROFILE and would silently diverge from a scoped
  // HOME.
  const home = resolve(options.home ?? ((options.sourceEnv ?? process.env).HOME || homedir()));
  const target = options.target ?? "remote";
  const platform = options.platform ?? process.platform;
  const runnerNodePath = resolve(options.nodePath ?? process.execPath);
  // Vendor-controlled npm/curl/shell children receive the shared minimal
  // runtime env, never the parent process's provider credentials.
  const resolutionSource = {
    ...(options.sourceEnv ?? process.env),
    HOME: home,
    // Local resolution must not read the SSH-runtime vendor prefix; the remote
    // flow keeps whatever its own runtime already exported.
    ...(target === "local" ? { CLAUDEXOR_REMOTE_RUNTIME: "0" } : {}),
  };
  const environment = {
    ...composeBaseEnv("clean", resolutionSource, runnerNodePath, platform),
    // npm and the vendor image cannot start on Windows without the process
    // environment the OS itself resolves against (the login/setup lanes
    // forward the same named set).
    ...(platform === "win32"
      ? pickAllowlistedEnv(resolutionSource, WINDOWS_RUNTIME_ENV_KEYS, platform)
      : {}),
    HOME: home,
  };
  return {
    home,
    target,
    runnerNodePath,
    platform,
    arch: options.arch ?? process.arch,
    resolutionSource,
    environment,
    spawn: options.spawn ?? spawnSync,
  };
}
