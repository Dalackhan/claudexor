/** Target selection BEFORE install disclosure and consent: it installs
 * nothing and takes no lease, but proves an existing managed copy with its
 * bounded `--version` and may make one bounded registry read. Ordinary
 * installs keep a proved managed copy; a fresh Codex install uses one exact
 * registry latest. This is separate from the mutation/proof owner and the
 * release-tested fixture baseline. */
import {
  compareVendorVersions,
  EXACT_VENDOR_VERSION,
  managedNpmPackageVersion,
  proveInstalledNpm,
} from "./harness-install-proof.js";
import {
  harnessInstallerDisclosure,
  NPM_PINS,
  TARGET_LAYOUTS,
  type HarnessInstallerDisclosure,
  type HarnessInstallTarget,
  type InstallableHarness,
} from "./harness-install-recipes.js";
import type { InstallerRuntime } from "./harness-install-runtime.js";
import { resolveLatestNpmVersion } from "./harness-latest.js";

interface InstallVersionChoice {
  selectedVersion?: string;
  /** Every automatic selection (no exact version or baseline request): a
   * runnable managed copy at or above the release-tested baseline that
   * appears after this read still wins, exactly as it would have here. */
  keepRunnableBaselineOrNewer: boolean;
}

type InstallVersionResult = InstallVersionChoice | { problem: { code: string; message: string } };

function runnableManagedNpmVersion(
  harness: InstallableHarness,
  runtime: InstallerRuntime,
): string | null {
  if (runtime.target !== "local") return null;
  const pin = NPM_PINS[harness];
  if (!pin) return null;
  const root = TARGET_LAYOUTS.local.root(runtime.home);
  const declared = managedNpmPackageVersion(root, pin.npmPackage, runtime.platform);
  if (!declared || !EXACT_VENDOR_VERSION.test(declared)) return null;
  if (compareVendorVersions(declared, pin.version) < 0) return null;
  const proof = proveInstalledNpm(
    {
      vendorRoot: root,
      npmPackage: pin.npmPackage,
      binaryNames: pin.binaryNames,
      expectedVersion: declared,
    },
    runtime,
  );
  return proof.ok ? declared : null;
}

/** Codex without an explicit version choice: its target is decided only by
 * this read (managed copy or one registry lookup), never by the baseline. */
function selectsDefaultLatest(
  harness: InstallableHarness,
  explicitVersion: string | undefined,
  releaseTested: boolean,
): boolean {
  return harness === "codex" && explicitVersion === undefined && !releaseTested;
}

/** What a refusal BEFORE selection may disclose: only a version the caller
 * chose. Codex's default target is still undecided, so it is not the baseline. */
export function preselectionDisclosure(
  harness: InstallableHarness,
  target: HarnessInstallTarget,
  platform: NodeJS.Platform,
  arch: string,
  explicitVersion: string | undefined,
  releaseTested: boolean,
): Partial<HarnessInstallerDisclosure> {
  const disclosure = harnessInstallerDisclosure(harness, target, platform, arch, explicitVersion);
  if (!selectsDefaultLatest(harness, explicitVersion, releaseTested)) return disclosure;
  return { harness, target, installLocation: disclosure.installLocation };
}

/** Never a silent baseline: a refused default selection names both explicit
 * choices. The baseline skips only the lookup; installing it still uses npm.
 * A missing bundled npm is local: no retry or other choice can help. */
function refusedDefault(code: string, message: string): InstallVersionResult {
  if (code === "embedded_npm_missing")
    return { problem: { code, message: `${message}; nothing was executed` } };
  const retry = code === "latest_unavailable" ? "retry when the npm registry answers, or " : "";
  return {
    problem: {
      code,
      message:
        `${message}; nothing was executed — ${retry}choose explicitly: --release-tested ` +
        `selects ${NPM_PINS.codex!.version} without a latest lookup (installing it still ` +
        "needs the npm registry), or --vendor-version <exact>",
    },
  };
}

export function selectInstallVersion(
  harness: InstallableHarness,
  runtime: InstallerRuntime,
  explicitVersion: string | undefined,
  releaseTested: boolean,
  exists?: (path: string) => boolean,
): InstallVersionResult {
  const pin = NPM_PINS[harness];
  const defaultCodex = selectsDefaultLatest(harness, explicitVersion, releaseTested);
  // A working installation is tested before any network dependency; a dry run
  // of a no-op should not make availability depend on a registry outage.
  const runnable =
    explicitVersion === undefined ? runnableManagedNpmVersion(harness, runtime) : null;
  let selectedVersion = explicitVersion ?? (releaseTested ? pin?.version : undefined);
  if (defaultCodex) {
    selectedVersion = runnable ?? undefined;
    if (!selectedVersion) {
      const latest = resolveLatestNpmVersion(harness, runtime, exists);
      if ("problem" in latest) return refusedDefault(latest.problem.code, latest.problem.message);
      if (compareVendorVersions(latest.version, NPM_PINS.codex!.version) < 0)
        return refusedDefault(
          "latest_older_than_tested",
          `the published Codex latest is older than the release-tested ${NPM_PINS.codex!.version}`,
        );
      selectedVersion = latest.version;
    }
  } else if (runnable) {
    // The tested-baseline request and other recipes' ensure preserve a newer
    // working copy. Their disclosure must not relabel it as release-verified.
    selectedVersion = runnable;
  }
  return {
    selectedVersion,
    keepRunnableBaselineOrNewer: explicitVersion === undefined && !releaseTested,
  };
}
