import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalIsolationLocator, providerScrubEnv } from "@claudexor/core";
import type { CredentialProfile } from "@claudexor/schema";

type Env = Record<string, string | null | undefined>;
const MANAGED_CONFIG: Env = {
  GROK_CONFIG: JSON.stringify({ cli: { auto_update: false } }),
  GROK_CONFIG_PATH: null,
};

export function canonicalGrokProfileHome(locator: string): string {
  return canonicalIsolationLocator(locator, "credential profile Grok HOME");
}

/** HOME and GROK_HOME must agree for login, models, and execution. */
export function grokProfileEnv(locator: string, env: Env = {}): Env {
  const home = canonicalGrokProfileHome(locator);
  return {
    ...env,
    ...providerScrubEnv(),
    ...MANAGED_CONFIG,
    HOME: home,
    USERPROFILE: home,
    GROK_HOME: join(home, ".grok"),
  };
}

export function grokRouteEnv(profile?: CredentialProfile | null, env: Env = {}): Env {
  if (profile) {
    if (profile.harness_id !== "grok" || profile.credential_kind !== "config_dir_login")
      throw new Error(`credential profile "${profile.profile_id}": Grok requires config_dir_login`);
    return grokProfileEnv(profile.isolation_locator ?? "", env);
  }
  // Engine lane HOME is for session state, not a new credential identity.
  return {
    ...env,
    ...providerScrubEnv(),
    ...MANAGED_CONFIG,
    GROK_HOME: env.GROK_HOME || process.env.GROK_HOME || join(homedir(), ".grok"),
  };
}

/** File presence is diagnostic only; `grok models` owns authentication proof.
 * Do not export credentials, JSON parse errors, or stale expiry guesses. The
 * official CLI owns renewal, including expired OIDC sessions. */
export function grokLoginPresent(env: Env): boolean {
  try {
    const path = join(env.GROK_HOME!, "auth.json");
    if (statSync(path).size > 64 * 1024) return false;
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    return [
      "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828",
      "https://accounts.x.ai/sign-in",
    ].some((scope) => {
      const entry = (data as Record<string, { key?: unknown }>)[scope];
      return (
        typeof entry?.key === "string" && entry.key.trim().length > 0 && !/[\r\n]/.test(entry.key)
      );
    });
  } catch {
    return false;
  }
}
