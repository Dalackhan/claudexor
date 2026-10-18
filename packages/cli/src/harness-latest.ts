/** One bounded, credential-free npm latest lookup shared by initial install
 * and managed maintenance. Its exact result is the install target; never ask
 * npm to execute a floating @latest after the owner saw another version. */
import { embeddedNpmCli } from "@claudexor/core";
import { EXACT_VENDOR_VERSION } from "./harness-install-proof.js";
import { NPM_PINS, type InstallableHarness } from "./harness-install-recipes.js";
import type { InstallerRuntime } from "./harness-install-runtime.js";

const LATEST_TIMEOUT_MS = 30_000;

export function resolveLatestNpmVersion(
  harness: InstallableHarness,
  runtime: InstallerRuntime,
): { version: string } | { problem: { code: string; message: string } } {
  const pin = NPM_PINS[harness];
  if (!pin)
    return { problem: { code: "latest_unsupported", message: `${harness} has no npm recipe` } };
  let result: ReturnType<InstallerRuntime["spawn"]>;
  try {
    result = runtime.spawn(
      runtime.runnerNodePath,
      [
        embeddedNpmCli(runtime.runnerNodePath, runtime.platform),
        "view",
        `${pin.npmPackage}@latest`,
        "version",
        "--json",
      ],
      {
        env: runtime.environment,
        encoding: "utf8",
        timeout: LATEST_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    return {
      problem: {
        code: "latest_unavailable",
        message: `the npm latest lookup for ${pin.npmPackage} could not start`,
      },
    };
  }
  let value: unknown = null;
  try {
    value = JSON.parse(String(result.stdout ?? "").trim());
  } catch {
    value = null;
  }
  return result.status === 0 && typeof value === "string" && EXACT_VENDOR_VERSION.test(value)
    ? { version: value }
    : {
        problem: {
          code: "latest_unavailable",
          message: `the registry did not answer one exact latest version for ${pin.npmPackage} (npm exit ${result.status ?? "none"})`,
        },
      };
}
