import { runCapture, type EnvMap } from "@claudexor/core";
import type { HarnessModel } from "@claudexor/schema";
import { resolveGrokBin } from "./bin.js";
import { grokLoginPresent } from "./profile.js";

export const GROK_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export function parseGrokModels(text: string): HarnessModel[] {
  const models = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+(grok-[A-Za-z0-9._-]+)(?:\s|$)/.exec(line);
    if (match) models.add(match[1]!);
  }
  return [...models].map((id) => ({
    id,
    label: null,
    context_window: null,
    routes: ["local_session"],
  }));
}

export async function probeGrokLogin(
  env: EnvMap,
  abortSignal?: AbortSignal,
): Promise<{
  authenticated: boolean;
  models: HarnessModel[];
  detail: string;
  failed?: boolean;
}> {
  if (!grokLoginPresent(env))
    return {
      authenticated: false,
      models: [],
      detail: "Grok login missing or invalid; run grok login in the selected profile",
    };
  try {
    const result = await runCapture(resolveGrokBin(), ["models"], {
      env,
      timeoutMs: 20_000,
      abortSignal,
    });
    const text = result.stdout + "\n" + result.stderr;
    const authenticated = /You are logged in with grok\.com\./i.test(text);
    return {
      authenticated,
      models: authenticated ? parseGrokModels(text) : [],
      detail: authenticated
        ? "Grok CLI accepted the grok.com subscription login"
        : "Grok subscription login was not confirmed; run grok login in the selected profile",
    };
  } catch {
    return {
      authenticated: false,
      models: [],
      failed: true,
      detail: "Grok login probe failed; login state is unknown",
    };
  }
}
