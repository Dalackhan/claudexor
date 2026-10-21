import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateGlobalConfig } from "@claudexor/config";
import type { HarnessAdapter } from "@claudexor/core";
import { HarnessGateway, type HarnessStatus } from "@claudexor/gateway";
import { normalizeRunStartRequest } from "@claudexor/control-api";
import {
  handleThreadTurnCreate,
  type ThreadTurnRouteCtx,
} from "../../control-api/src/thread-turn-routes.js";
import {
  Attachment,
  ConformanceReport,
  ControlRunStartRequest,
  ControlThreadTurnRequest,
  CredentialProfile,
  HarnessManifest,
  HarnessCapabilityProfile,
  type Intent,
  type AttachmentInputClass,
} from "@claudexor/schema";
import { createRunRequirementsPreflight } from "./request-preflight.js";

const textInput: AttachmentInputClass = {
  kind: "file",
  mime_types: ["text/plain"],
  max_bytes: 1024,
  max_count: 1,
  transport: "text_inline",
};
const attachment = Attachment.parse({
  resource_id: "notes",
  kind: "file",
  mime: "text/plain",
  name: "notes.txt",
  sha256: `sha256:${"a".repeat(64)}`,
  size_bytes: 12,
  path: "/fixture/notes.txt",
});
const profile = (id: string, harness = "codex", enabled = true) =>
  CredentialProfile.parse({
    profile_id: id,
    harness_id: harness,
    display_name: id,
    enabled,
    credential_kind: "config_dir_login",
    isolation_locator: `/fixture/profiles/${harness}/${id}`,
  });

function lane(
  id: string,
  options: {
    defaultReady?: boolean;
    unready?: string[];
    attachments?: boolean;
    browser?: boolean;
    implement?: boolean;
    enabledIntents?: Intent[];
  } = {},
) {
  const probe = vi.fn(async (row: CredentialProfile) => ({
    profile_id: row.profile_id,
    harness_id: id,
    availability: "available" as const,
    verification: options.unready?.includes(row.profile_id)
      ? ("failed" as const)
      : ("passed" as const),
    verification_source: "local_store" as const,
    last_verified_at: null,
    detail: options.unready?.includes(row.profile_id)
      ? "vendor refused this profile"
      : "profile authenticated",
  }));
  const adapter: HarnessAdapter = {
    id,
    discover: async () =>
      HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "local",
        capability_profile: {
          attachment_inputs: options.attachments === false ? [] : [textInput],
          mcp_injection_requires_full_access: true,
        },
        capabilities: {
          implement: options.implement ?? true,
          read_files: true,
          browser_tool: options.browser ?? true,
        },
        access_profiles_supported: ["readonly", "workspace_write", "full"],
      }),
    doctor: async () =>
      ConformanceReport.parse({
        harness_id: id,
        status: options.defaultReady ? "ok" : "unavailable",
        enabled_intents: options.enabledIntents ?? [],
        reasons: options.defaultReady ? [] : ["default HOME is not authenticated"],
      }),
    probeCredentialProfile: probe,
    async *run() {
      throw new Error("preflight must never start a vendor run");
    },
  };
  return { adapter, probe };
}

function fixture(
  lanes: ReturnType<typeof lane>[],
  sticky: string | null = "sticky",
  credentialReadiness?: NonNullable<
    Parameters<typeof createRunRequirementsPreflight>[2]
  >["credentialReadiness"],
  projectStatuses?: (
    statuses: HarnessStatus[],
  ) => Array<Pick<HarnessStatus, "id" | "status" | "enabledIntents">>,
) {
  const registry = new Map(lanes.map(({ adapter }) => [adapter.id, adapter]));
  const gateway = new HarnessGateway(registry);
  return createRunRequirementsPreflight(
    { resolve: (refs) => (refs?.length ? [attachment] : []) },
    "/fixture/no-project",
    {
      registry,
      statusAll: async (cwd, ids) => {
        const statuses = await gateway.statusAll({ cwd, fresh: true }, ids);
        return projectStatuses ? projectStatuses(statuses) : statuses;
      },
      threadProfileId: () => sticky,
      credentialReadiness,
      accessDefault: () => "full",
      gitCapability: async () => ({
        status: "available",
        version: "fixture",
        detail: null,
        remediation: null,
      }),
    },
  );
}
const request = (overrides: Record<string, unknown> = {}) =>
  ControlRunStartRequest.parse({
    prompt: "read notes",
    mode: "agent",
    scope: { kind: "project", root: "/fixture/project" },
    attachments: [{ resourceId: "notes" }],
    ...overrides,
  });

beforeEach(() => {
  process.env.CLAUDEXOR_CONFIG_DIR = mkdtempSync(join(tmpdir(), "preflight-profiles-"));
  updateGlobalConfig((config) => ({
    ...config,
    credential_profiles: [profile("work"), profile("sticky")],
  }));
});

describe("profile-aware requirements preflight", () => {
  it.each([
    { pin: false, browser: false },
    { pin: true, browser: false },
    { pin: false, browser: true },
    { pin: true, browser: true },
  ])(
    "discovery failures: Auto keeps a ready lane, pin=$pin browser=$browser",
    async ({ pin, browser }) => {
      updateGlobalConfig((config) => ({
        ...config,
        credential_profiles: [profile("work"), profile("work", "other")],
      }));
      const unavailable = lane("codex");
      const discover = vi.fn(async () => {
        throw new Error("vendor executable is not installed");
      });
      unavailable.adapter.discover = discover;
      const other = lane("other", { defaultReady: true });
      await expect(
        fixture([unavailable, other])(
          request({
            ...(pin ? { credentialProfileId: "work" } : {}),
            ...(browser ? { browser: true, attachments: [], access: "full" } : {}),
          }),
        ),
      ).resolves.toBeUndefined();
      expect(discover).toHaveBeenCalledTimes(1);
      expect(unavailable.probe).not.toHaveBeenCalled();
    },
  );

  it("discovery failures: explicit pools refuse a Gateway-null manifest typed", async () => {
    updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: [profile("work"), profile("work", "other")],
    }));
    const unavailable = lane("codex");
    const discover = vi.fn(async () => {
      throw new Error("vendor executable is not installed");
    });
    unavailable.adapter.discover = discover;
    const other = lane("other", { defaultReady: true });
    await expect(
      fixture([unavailable, other])(
        request({
          credentialProfileId: "work",
          harnesses: ["codex", "other"],
        }),
      ),
    ).rejects.toMatchObject({ code: "harness_unavailable", status: 400 });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(unavailable.probe).not.toHaveBeenCalled();
  });

  it("discovery failures: reuses an already discovered Gateway manifest", async () => {
    const codex = lane("codex");
    const discover = vi.fn(codex.adapter.discover);
    codex.adapter.discover = discover;
    await expect(
      fixture([codex])(request({ credentialProfileId: "work" })),
    ).resolves.toBeUndefined();
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it.each([
    { projection: "without_manifest", explicit: false },
    { projection: "without_manifest", explicit: true },
    { projection: "without_status", explicit: false },
    { projection: "without_status", explicit: true },
  ])(
    "discovery failures: projected $projection keeps pool semantics, explicit=$explicit",
    async ({ projection, explicit }) => {
      updateGlobalConfig((config) => ({
        ...config,
        credential_profiles: [profile("work"), profile("work", "other")],
      }));
      const unavailable = lane("codex");
      const discover = vi.fn(async () => {
        throw new Error("vendor executable is not installed");
      });
      unavailable.adapter.discover = discover;
      const other = lane("other", { defaultReady: true });
      const preflight = fixture([unavailable, other], null, undefined, (statuses) =>
        projection === "without_status"
          ? statuses.filter((status) => status.id !== "codex")
          : statuses.map(({ id, status, enabledIntents }) => ({ id, status, enabledIntents })),
      );
      const result = preflight(
        request({
          credentialProfileId: "work",
          ...(explicit ? { harnesses: ["codex", "other"] } : {}),
        }),
      );
      if (explicit) {
        await expect(result).rejects.toMatchObject({ code: "harness_unavailable", status: 400 });
      } else {
        await expect(result).resolves.toBeUndefined();
      }
      expect(discover).toHaveBeenCalledTimes(projection === "without_status" ? 1 : 2);
      expect(unavailable.probe).not.toHaveBeenCalled();
    },
  );

  it.each([
    { input: {}, expected: "sticky" },
    { input: { credentialProfileId: "work" }, expected: "work" },
    { input: { credentialProfileId: null }, expected: "work" },
  ])(
    "preserves turn profile intent through the real route: $input",
    async ({ input, expected }) => {
      const codex = lane("codex");
      const preflight = fixture([codex]);
      let response: { status: number; body: unknown } | undefined;
      let enqueued: unknown;
      const ctx: ThreadTurnRouteCtx = {
        json: (_res, status, body) => {
          response = { status, body };
        },
        normalizeStart: normalizeRunStartRequest,
        preflightThreadRunRequirements: preflight,
        threadTurnChains: new Map(),
        threadDetail: async () => ({
          thread: {
            repo: null,
            mode: "ask",
            auth_preference: "auto",
            head_run_id: null,
            primary_harness: null,
            eligible_harnesses: [],
            workspace: { mode: "in_place" },
          },
          sessions: [],
          turns: [],
        }),
        createThreadTurn: async () => ({ id: "turn" }),
        waitForRunStart: async () => ({ id: "job", state: "queued" }) as never,
        isTerminalState: () => false,
        readRunArtifactText: async () => null,
        resolveRunArtifactPath: async () => null,
        daemon: {
          enqueue: async (params) => {
            enqueued = params;
            return { id: "job", state: "queued" };
          },
        } as ThreadTurnRouteCtx["daemon"],
      };
      await handleThreadTurnCreate(
        ctx,
        {} as ServerResponse,
        "thread",
        ControlThreadTurnRequest.parse({
          prompt: "read notes",
          mode: "ask",
          attachments: [{ resourceId: "notes" }],
          ...input,
        }),
        "request-key",
      );
      expect(response).toMatchObject({ status: 202 });
      expect(codex.probe.mock.calls.map(([row]) => row.profile_id)).toEqual([expected]);
      if ("credentialProfileId" in input) {
        expect(enqueued).toHaveProperty("credentialProfileId", input.credentialProfileId);
      } else {
        expect(enqueued).not.toHaveProperty("credentialProfileId");
      }
    },
  );

  it("admits Auto attachments on the exact authenticated pin despite logged-out default HOME", async () => {
    const codex = lane("codex");
    await expect(
      fixture([codex])(request({ credentialProfileId: "work" })),
    ).resolves.toBeUndefined();
    expect(codex.probe.mock.calls.map(([row]) => row.profile_id)).toEqual(["work"]);
  });

  it("inherits a thread pin only when the per-turn field is absent; explicit id wins", async () => {
    const codex = lane("codex", { unready: ["sticky"] });
    const preflight = fixture([codex]);
    await expect(
      preflight(request({ threadId: "thread", credentialProfileId: "work" })),
    ).resolves.toBeUndefined();
    expect(codex.probe.mock.calls.map(([row]) => row.profile_id)).toEqual(["work"]);
    await expect(preflight(request({ threadId: "thread" }))).rejects.toThrow(
      /sticky.*vendor refused/,
    );
  });

  it("admits an inherited authenticated thread pin and does not probe another account", async () => {
    const codex = lane("codex");
    await expect(fixture([codex])(request({ threadId: "thread" }))).resolves.toBeUndefined();
    expect(codex.probe.mock.calls.map(([row]) => row.profile_id)).toEqual(["sticky"]);
  });

  it("preserves explicit null through parsing and clears sticky for this turn", async () => {
    const codex = lane("codex", { unready: ["sticky"] });
    const parsed = request({ threadId: "thread", credentialProfileId: null });
    expect(parsed).toHaveProperty("credentialProfileId", null);
    expect(request({ threadId: "thread" })).not.toHaveProperty("credentialProfileId");
    await expect(fixture([codex])(parsed)).resolves.toBeUndefined();
    expect(codex.probe.mock.calls.map(([row]) => row.profile_id)).toEqual(["work"]);
  });

  it.each(["missing", "disabled", "unready"])(
    "refuses a %s pin without a healthy default or sibling fallback",
    async (state) => {
      updateGlobalConfig((config) => ({
        ...config,
        credential_profiles: [profile("work", "codex", state !== "disabled"), profile("sibling")],
      }));
      const codex = lane("codex", { defaultReady: true, unready: ["work"] });
      const other = lane("other", { defaultReady: true });
      await expect(
        fixture([codex, other])(
          request({ credentialProfileId: state === "missing" ? "ghost" : "work" }),
        ),
      ).rejects.toThrow(
        state === "missing"
          ? /ghost.*not registered/
          : state === "disabled"
            ? /work.*disabled/
            : /work.*vendor refused/,
      );
      expect(codex.probe.mock.calls.every(([row]) => row.profile_id === "work")).toBe(true);
      expect(other.probe).not.toHaveBeenCalled();
    },
  );

  it("keeps an explicit pool strict for profile ownership and attachment capability", async () => {
    const codex = lane("codex");
    const other = lane("other", { defaultReady: true });
    await expect(
      fixture([codex, other])(request({ credentialProfileId: "work", harnesses: ["other"] })),
    ).rejects.toThrow(/work.*not registered.*other/);
    expect(other.probe).not.toHaveBeenCalled();
    const incapable = lane("codex", { attachments: false });
    await expect(
      fixture([incapable])(request({ credentialProfileId: "work", harnesses: ["codex"] })),
    ).rejects.toMatchObject({ code: "attachment_pool_unsupported" });
  });

  it("uses the same profile path for Browser-only requests and keeps access/web refusal", async () => {
    const codex = lane("codex");
    const preflight = fixture([codex]);
    const browser = { credentialProfileId: "work", attachments: [], browser: true, access: "full" };
    await expect(preflight(request(browser))).resolves.toBeUndefined();
    await expect(
      preflight(request({ ...browser, access: "workspace_write" })),
    ).rejects.toMatchObject({ code: "browser_unavailable" });
    await expect(preflight(request({ ...browser, web: "off" }))).rejects.toMatchObject({
      code: "browser_unavailable",
    });
  });

  it("does not replace a pinned attachment-incompatible harness with another account", async () => {
    const codex = lane("codex", { attachments: false });
    const other = lane("other", { defaultReady: true });
    await expect(
      fixture([codex, other])(request({ credentialProfileId: "work" })),
    ).rejects.toMatchObject({ code: "attachment_pool_unsupported" });
    expect(other.probe).not.toHaveBeenCalled();
  });

  it("refuses disabled harnesses and unsupported intents even with a ready profile", async () => {
    const codex = lane("codex", { implement: false });
    await expect(fixture([codex])(request({ credentialProfileId: "work" }))).rejects.toThrow();
    updateGlobalConfig((config) => ({
      ...config,
      harnesses: { codex: { ...config.harnesses.codex, enabled: false } },
    }));
    await expect(
      fixture([lane("codex")])(request({ credentialProfileId: "work" })),
    ).rejects.toThrow(/unavailable|disabled/);
  });

  it("keeps doctor intent exclusions on a healthy default even when the pin is ready", async () => {
    const codex = lane("codex", { defaultReady: true, enabledIntents: ["explain"] });
    await expect(fixture([codex])(request({ credentialProfileId: "work" }))).rejects.toThrow(
      /cannot implement/,
    );
  });

  it("rejects an ambiguous platform binding set without probing a profile", async () => {
    const codex = lane("codex");
    codex.adapter = {
      ...codex.adapter,
      capabilityProfile: HarnessCapabilityProfile.parse({
        auth: {
          credential_profile_policies: [
            {
              source: "native_session",
              platforms: ["darwin", "linux", "win32"],
              identity_scope: "os_user",
              max_enabled_profiles: 1,
              cleanup_owner: "vendor",
            },
          ],
        },
      }),
    };
    await expect(fixture([codex])(request({ credentialProfileId: "work" }))).rejects.toMatchObject({
      code: "credential_profile_ambiguous",
    });
    expect(codex.probe).not.toHaveBeenCalled();
  });

  it("keeps a shared profile's Auto pool distinct from a strict explicit pool", async () => {
    updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: [profile("work"), profile("work", "other")],
    }));
    const codex = lane("codex", { unready: ["work"] });
    const other = lane("other");
    const preflight = fixture([codex, other]);
    await expect(preflight(request({ credentialProfileId: "work" }))).resolves.toBeUndefined();
    await expect(
      preflight(request({ credentialProfileId: "work", harnesses: ["codex", "other"] })),
    ).rejects.toThrow(/work.*vendor refused/);
  });

  it("acts on the daemon's revoked-credential evidence instead of local store presence", async () => {
    const codex = lane("codex", { defaultReady: true });
    const preflight = fixture([codex], null, () => ({
      quota: { snapshots: [], absences: [] },
      unusable: [
        {
          harness_id: "codex",
          profile_id: "work",
          model: null,
          code: "auth_revoked",
          source: "vendor_poller",
          detail: null,
          observed_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    }));
    await expect(preflight(request({ credentialProfileId: "work" }))).rejects.toThrow(
      /work.*auth_revoked/,
    );
    expect(codex.probe).not.toHaveBeenCalled();
  });
});
