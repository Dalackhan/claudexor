import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonicalIsolationLocator, providerScrubEnv } from "@claudexor/core";
import type { CredentialProfile } from "@claudexor/schema";

type Env = Record<string, string | null | undefined>;
const MANAGED_ENV: Env = {
  GROK_DISABLE_AUTOUPDATER: "1",
  GROK_CONFIG: null,
  GROK_CONFIG_PATH: null,
};

export const GROK_PROFILE_REQUIRED =
  "Grok has no default credential store; select a named profile (--profile <id>): " +
  "claudexor profiles add grok <id> and claudexor profiles login grok <id>";

export function canonicalGrokProfileHome(locator: string): string {
  return canonicalIsolationLocator(locator, "credential profile Grok HOME");
}

/** HOME and GROK_HOME must agree for login, models, and execution. */
export function grokProfileEnv(locator: string, env: Env = {}): Env {
  if (!locator) throw new Error(GROK_PROFILE_REQUIRED);
  const home = canonicalGrokProfileHome(locator);
  return {
    ...env,
    ...providerScrubEnv(),
    ...MANAGED_ENV,
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
  throw new Error(GROK_PROFILE_REQUIRED);
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
