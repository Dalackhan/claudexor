import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@claudexor/schema", () => import("../../schema/src/index.js"));
vi.mock("./daemon-run.js", () => ({
  connectDaemonIfRunning: vi.fn(),
  ensureDaemon: vi.fn(),
  enqueueAndAwait: vi.fn(),
}));
vi.mock("./live.js", async (original) => ({
  ...(await original<object>()),
  controlApiFetch: vi.fn(),
}));
import { ControlRunStartRequest } from "@claudexor/schema";
import { connectDaemonIfRunning, ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { boundedDeferredMessage, deferredMessageQuery } from "./mcp-deferred-message.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";
import { deferredMessageTools } from "../../mcp-server/src/deferred-message-tools.js";
import { beltClaudexorTools } from "../../mcp-server/src/delegation-belt.js";
import { runWaitQuery } from "./mcp-run-wait.js";
import { projectImmediateRunDetail, projectRecoveryRunDetail } from "./mcp-run-projections.js";

const draft = {
  draftId: "draft-1",
  revision: 1,
  state: "waiting" as const,
  predecessorJobId: "job-1",
  predecessorRunId: "run-1",
  predecessorResult: "/v2/runs/run-1",
  hold: null,
  dispatchedRevision: null,
  successorJobId: null,
  successorRunId: null,
};
const call = {
  request: { action: "create", predecessorId: "job-1", prompt: "verify", attachments: [] },
  idempotencyKey: "stable",
};
afterEach(() => vi.resetAllMocks());
function connected(body: unknown) {
  vi.mocked(connectDaemonIfRunning).mockResolvedValue({
    addr: { baseUrl: "http://fixture", token: "fixture" },
  } as never);
  vi.mocked(controlApiFetch).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  } as never);
}
describe("operator MCP next-message boundary", () => {
  it("projects waiting draft independently from terminal predecessor status/result/wait", async () => {
    const detail = {
      summary: { jobId: "job-1", runId: "run-1", state: "succeeded" },
      lastSeq: 0,
      pendingInteractions: [],
      deferredMessage: draft,
    };
    expect(projectImmediateRunDetail(detail)).toMatchObject({ deferredMessage: draft });
    expect(projectRecoveryRunDetail("__run_status", "job-1", detail)).toMatchObject({
      deferredMessage: draft,
    });
    expect(projectRecoveryRunDetail("__run_result", "job-1", detail)).toMatchObject({
      deferredMessage: draft,
    });
    connected(detail);
    expect(await runWaitQuery({ runId: "job-1", waitMs: 0 })).toMatchObject({
      status: "succeeded",
      wakeReason: "terminal",
      deferredMessage: { state: "waiting", successorJobId: null },
    });
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(controlApiFetch).mock.calls[0]![2]).toMatchObject({ method: "GET" });
  });
  it.each(["__next_message", "__next_message_read"])(
    "refuses %s on the actual belt runner before discovery or HTTP",
    async (mode) => {
      await expect(
        mcpSurfaceRunner({ delegationParentRunId: "parent" })({ mode, ...call }),
      ).rejects.toMatchObject({ code: "delegation_forbidden", status: 403 });
      await expect(
        deferredMessageQuery({ mode, ...call, delegatedFromRunId: "parent" }),
      ).rejects.toMatchObject({ code: "delegation_forbidden" });
      expect(connectDaemonIfRunning).not.toHaveBeenCalled();
      expect(controlApiFetch).not.toHaveBeenCalled();
      expect(ensureDaemon).not.toHaveBeenCalled();
    },
  );
  it("forwards complete actions and stable keys once, without start normalization", async () => {
    connected({ appliedRevision: 1, draft });
    expect(await mcpSurfaceRunner()({ mode: "__next_message", ...call })).toEqual({
      appliedRevision: 1,
      draft,
    });
    expect(controlApiFetch).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "/runs/next-message",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "stable" },
        body: JSON.stringify(call.request),
      }),
    );
    expect(ensureDaemon).not.toHaveBeenCalled();
  });
  it("refuses engine child targets using the daemon's typed HTTP verdict", async () => {
    connected({});
    vi.mocked(controlApiFetch).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        code: "delegation_forbidden",
        message: "Delegate children cannot reserve work",
        retryable: false,
      }),
    } as never);
    const result = await deferredMessageTools(mcpSurfaceRunner())[0]!.handler(call, {});
    expect(result).toMatchObject({
      isError: true,
      structured: { failure: { code: "delegation_forbidden" } },
    });
  });
  it("bounds UTF-8 content and returns exact predecessor/result and full editing handles", async () => {
    const detail = {
      ...draft,
      prompt: "🙂".repeat(3000),
      attachments: [],
      capturedStart: ControlRunStartRequest.parse({ prompt: "verify" }),
    };
    const bounded = boundedDeferredMessage(detail);
    expect(Buffer.byteLength(bounded.promptPreview)).toBe(4096);
    expect(bounded.promptPreview).not.toContain("�");
    expect(bounded.promptBytes).toBe(12000);
    expect(bounded.omittedPromptBytes).toBe(7904);
    expect(bounded.draft.predecessorResult).toBe("/v2/runs/run-1");
    connected(detail);
    expect(await deferredMessageQuery({ mode: "__next_message_read", draftId: "draft-1" })).toEqual(
      bounded,
    );
    expect(bounded).not.toHaveProperty("capturedStart");
  });
  it("advertises the two operator tools with schemas and excludes both from the Delegate belt", () => {
    const tools = deferredMessageTools(vi.fn());
    expect(tools.map((t) => t.name)).toEqual([
      "claudexor_next_message",
      "claudexor_next_message_read",
    ]);
    const belt = beltClaudexorTools(vi.fn(), {
      parentRunId: "p",
      repoRoot: "/tmp",
      depth: 0,
      maxSubRuns: 1,
      parentBudget: { kind: "finite", maxUsd: 1 },
    });
    expect(belt.some((t) => t.name.startsWith("claudexor_next_message"))).toBe(false);
  });
});
