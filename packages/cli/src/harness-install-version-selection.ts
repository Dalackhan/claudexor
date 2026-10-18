/** Read-only target selection BEFORE install disclosure and consent. Ordinary
 * installs keep a proved managed copy; a fresh Codex install uses one exact
 * registry latest. This is separate from the mutation/proof owner and the
 * release-tested fixture baseline. */
import {
  compareVendorVersions,
  EXACT_VENDOR_VERSION,
  managedNpmPackageVersion,
  proveInstalledNpm,
} from "./harness-install-proof.js";
import { NPM_PINS, TARGET_LAYOUTS, type InstallableHarness } from "./harness-install-recipes.js";
import type { InstallerRuntime } from "./harness-install-runtime.js";
import { resolveLatestNpmVersion } from "./harness-latest.js";

interface InstallVersionChoice {
  selectedVersion?: string;
  /** A newer runnable managed copy that appears after this read still wins. */
  preserveNewerThanWanted: boolean;
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

export function selectInstallVersion(
  harness: InstallableHarness,
  runtime: InstallerRuntime,
  explicitVersion: string | undefined,
  releaseTested: boolean,
): InstallVersionResult {
  const pin = NPM_PINS[harness];
  const defaultCodex = harness === "codex" && explicitVersion === undefined && !releaseTested;
  // A working installation is tested before any network dependency; a dry run
  // of a no-op should not make availability depend on a registry outage.
  const runnable =
    explicitVersion === undefined ? runnableManagedNpmVersion(harness, runtime) : null;
  let selectedVersion = explicitVersion ?? (releaseTested ? pin?.version : undefined);
  if (defaultCodex) {
    selectedVersion = runnable ?? undefined;
    if (!selectedVersion) {
      const latest = resolveLatestNpmVersion(harness, runtime);
      if ("problem" in latest) return latest;
      if (compareVendorVersions(latest.version, NPM_PINS.codex!.version) < 0)
        return {
          problem: {
            code: "latest_older_than_tested",
            message: `the published Codex latest is older than the release-tested ${NPM_PINS.codex!.version}`,
          },
        };
      selectedVersion = latest.version;
    }
  } else if (runnable) {
    // The tested-baseline request and other recipes' ensure preserve a newer
    // working copy. Their disclosure must not relabel it as release-verified.
    selectedVersion = runnable;
  }
  return { selectedVersion, preserveNewerThanWanted: defaultCodex };
}
