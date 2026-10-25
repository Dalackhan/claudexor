import type { HarnessAdapter, DoctorSpec, HarnessModelSpec } from "@claudexor/core";
import {
  HarnessUnavailableError,
  abortSignalFromSpec,
  effortResolutionEvent,
  resolveEffortEvidence,
  runCliHarness,
  throwIfEffortRejected,
} from "@claudexor/core";
import {
  HarnessCapabilityProfile,
  HarnessManifest,
  ConformanceReport,
  CredentialProfileStatus,
  type CredentialProfile,
  type HarnessEvent,
  type HarnessRunSpec,
} from "@claudexor/schema";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import { detectGrokVersion, resolveGrokBin } from "./bin.js";
import { grokAccessArgs } from "./access.js";
import { GROK_EFFORTS, probeGrokLogin } from "./models.js";
import { grokLoginPresent, grokRouteEnv } from "./profile.js";
import { createGrokParser, grokFailure } from "./parse.js";
import { withGrokPromptFile } from "./prompt.js";
export { resolveGrokBin } from "./bin.js";
export { canonicalGrokProfileHome, grokProfileEnv } from "./profile.js";

export const GROK_MANAGED_LOGIN = { stdin: "none" } as const;
const INTENTS = [
  "explain",
  "audit",
  "plan",
  "spec",
  "implement",
  "repair",
  "create_from_scratch",
  "review",
  "verify",
  "synthesize",
];
export const GROK_CAPABILITY_PROFILE = HarnessCapabilityProfile.parse({
  auth: {
    supported_sources: ["native_session"],
    preferred_source: "native_session",
    credential_transports: [
      { source: "native_session", kind: "config_file", relocatable_by: ["HOME"] },
    ],
    managed_login: GROK_MANAGED_LOGIN,
  },
  access_control: {
    readonly_mechanism: "tool_allowlist",
    write_mechanism: "tool_policy",
    auxiliary_writable_roots: false,
  },
  isolation: { supported_containment: ["env_or_file_injection"] },
  attachment_inputs: [],
});

const defaults = {
  detectVersion: detectGrokVersion,
  probeLogin: probeGrokLogin,
  runCli: runCliHarness,
};
type Runtime = typeof defaults;

async function doctor(spec: DoctorSpec, runtime: Runtime) {
  const version = await runtime.detectVersion();
  const supported = spec.authSource === undefined || spec.authSource === "native_session";
  const probe =
    version && supported && spec.authPreference !== "api_key"
      ? await runtime.probeLogin(grokRouteEnv(null, spec.env), spec.abortSignal)
      : {
          authenticated: false,
          detail:
            !supported || spec.authPreference === "api_key"
              ? "Grok supports only grok.com subscription login"
              : "Grok CLI is unavailable",
        };
  const ready = version !== null && probe.authenticated;
  return ConformanceReport.parse({
    harness_id: "grok",
    status: ready ? "ok" : "unavailable",
    checks: [
      {
        id: "installed",
        status: version ? "pass" : "fail",
        detail: version ?? "grok not found; set CLAUDEXOR_GROK_BIN",
      },
      { id: "native_auth", status: ready ? "pass" : "fail", detail: probe.detail },
    ],
    enabled_intents: ready ? INTENTS : [],
    disabled_intents: ready ? [] : INTENTS,
    reasons: ready ? [] : [probe.detail],
    auth_sources: [
      {
        source: spec.authSource ?? "native_session",
        availability: ready ? "available" : "unavailable",
        verification: ready ? "passed" : "not_run",
        detail: probe.detail,
      },
    ],
  });
}

async function probeCredentialProfile(
  profile: CredentialProfile,
  runtime: Runtime,
  abortSignal?: AbortSignal,
) {
  const base = { profile_id: profile.profile_id, harness_id: "grok" };
  try {
    const probe = await runtime.probeLogin(grokRouteEnv(profile), abortSignal);
    return CredentialProfileStatus.parse({
      ...base,
      availability: probe.authenticated ? "available" : probe.failed ? "unknown" : "unavailable",
      verification: probe.authenticated ? "passed" : probe.failed ? "not_run" : "failed",
      ...(probe.authenticated ? { verification_source: "vendor", last_verified_at: nowIso() } : {}),
      detail: probe.detail,
    });
  } catch {
    return CredentialProfileStatus.parse({
      ...base,
      availability: "unavailable",
      verification: "failed",
      detail: "Grok requires a valid isolated config_dir_login profile",
    });
  }
}

export function createGrokAdapter(deps: Partial<Runtime> = {}): HarnessAdapter {
  const runtime = { ...defaults, ...deps };
  async function* stamped(spec: HarnessRunSpec) {
    for await (const event of withGrokPromptFile(spec.prompt, (path) =>
      runGrok(spec, runtime, path),
    )) {
      event.credential_route = "vendor_native";
      event.credential_source = "native_session";
      if (spec.credential_profile) event.credential_profile_id = spec.credential_profile.profile_id;
      yield event;
    }
  }
  return {
    id: "grok",
    effortParameter: "--reasoning-effort",
    capabilityProfile: GROK_CAPABILITY_PROFILE,
    nativeHomeLifetime: {
      status: "not_pruned",
      reason: "Grok session pruning has no independently verified contract",
    },
    async discover() {
      const version = await runtime.detectVersion();
      if (!version)
        throw new HarnessUnavailableError(
          "grok not found (install Grok Build or set CLAUDEXOR_GROK_BIN)",
        );
      return HarnessManifest.parse({
        id: "grok",
        display_name: "Grok Build",
        kind: "local_cli",
        version,
        adapter_version: CLAUDEXOR_VERSION,
        provider_family: "xai",
        capabilities: {
          plan: true,
          implement: true,
          create_from_scratch: true,
          review: true,
          verify: true,
          synthesize: true,
          read_files: true,
          browser_tool: false,
          max_turns: true,
          web_policy: "native",
          effort_levels: GROK_EFFORTS,
          effort_levels_verified_against: "1.0.46",
          model_inventory_absence: "advisory",
          json_schema_output: true,
          work_report_transport: "unsupported",
        },
        capability_profile: GROK_CAPABILITY_PROFILE,
        auth_modes: grokLoginPresent(grokRouteEnv()) ? ["local_session"] : [],
        access_profiles_supported: ["readonly", "workspace_write", "full", "inherit_native"],
      });
    },
    doctor: (spec) => doctor(spec, runtime),
    probeCredentialProfile: (profile, signal) => probeCredentialProfile(profile, runtime, signal),
    async models(spec?: HarnessModelSpec) {
      if (spec?.authPreference === "api_key") return [];
      try {
        return (
          await runtime.probeLogin(
            grokRouteEnv(spec?.credentialProfile, spec?.env),
            spec?.abortSignal,
          )
        ).models;
      } catch {
        return [];
      }
    },
    run: stamped,
    review: stamped,
  };
}

async function* runGrok(
  spec: HarnessRunSpec,
  runtime: Runtime,
  promptPath: string,
): AsyncGenerator<HarnessEvent> {
  if (spec.auth_preference === "api_key")
    throw new HarnessUnavailableError("Grok Build requires grok.com subscription authentication");
  let env;
  try {
    env = grokRouteEnv(spec.credential_profile, spec.env);
  } catch {
    throw new HarnessUnavailableError(
      "Grok credential profile is invalid; no default credential fallback is allowed",
    );
  }
  const probe = await runtime.probeLogin(env, abortSignalFromSpec(spec));
  if (!probe.authenticated) throw new HarnessUnavailableError(probe.detail);
  const effort = resolveEffortEvidence(
    spec.effort_hint,
    GROK_EFFORTS,
    GROK_EFFORTS,
    "versioned_snapshot",
    "--reasoning-effort",
  );
  yield effortResolutionEvent(spec.session_id, effort);
  throwIfEffortRejected(effort);
  const args = [
    "--prompt-file",
    promptPath,
    "--cwd",
    spec.cwd,
    "--output-format",
    "streaming-messages-json",
    ...grokAccessArgs(spec),
  ];
  if (spec.instructions) args.push("--rules", spec.instructions);
  if (spec.model_hint) args.push("-m", spec.model_hint);
  if (effort.submitted) args.push("--reasoning-effort", effort.submitted);
  if (spec.max_turns !== null) args.push("--max-turns", String(spec.max_turns));
  if (spec.output_schema) args.push("--json-schema", JSON.stringify(spec.output_schema));
  if (spec.resume_session_id) args.push("--resume", spec.resume_session_id);
  if (spec.tool_permission_policy.web === "off" || spec.external_context_policy === "off")
    args.push("--disable-web-search");
  const parser = createGrokParser();
  const scoped = spec.access === "readonly" || spec.access === "workspace_write";
  const allowedTools = new Set([
    "read_file",
    "list_dir",
    "grep",
    ...(spec.access === "workspace_write" ? ["search_replace", "write"] : []),
  ]);
  for await (const event of runtime.runCli({
    bin: resolveGrokBin(),
    args,
    spec,
    env,
    label: "grok",
    redact: redactSecrets,
    parseEvent: (raw, id) => {
      const init = raw as {
        type?: unknown;
        subtype?: unknown;
        tools?: unknown;
        permissionMode?: unknown;
        apiKeySource?: unknown;
      } | null;
      if (
        scoped &&
        init?.type === "system" &&
        init.subtype === "init" &&
        (!Array.isArray(init.tools) ||
          init.tools.some((tool) => typeof tool !== "string" || !allowedTools.has(tool)) ||
          init.permissionMode !== "dontAsk")
      ) {
        return [
          {
            ...grokFailure("Grok did not confirm the requested scoped tool policy", id),
            payload: { code: "grok_access_policy_unconfirmed" },
          },
        ];
      }
      return parser.parseEvent(raw, id);
    },
    stopAfterEvent: (event) => event.payload?.code === "grok_access_policy_unconfirmed",
    parseStderrFailure: (stderr, id) => grokFailure(stderr, id),
  })) {
    if (event.type === "completed" && !parser.hasTerminal() && event.payload?.exit_code === 0)
      yield grokFailure("Grok exited without a terminal result", spec.session_id);
    yield event;
  }
}
