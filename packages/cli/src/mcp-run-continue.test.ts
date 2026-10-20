import { afterEach, describe, expect, it, vi } from "vitest";
import { runContinueQuery } from "./mcp-run-continue.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";
import { connectDaemonIfRunning, enqueueAndAwait, ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";

vi.mock("./daemon-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./daemon-run.js")>()),
  connectDaemonIfRunning: vi.fn(),
  ensureDaemon: vi.fn(),
  enqueueAndAwait: vi.fn(),
}));
// Only the transport is faked; pure projection helpers stay real.
vi.mock("./live.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./live.js")>()),
  controlApiFetch: vi.fn(),
}));

function connected(body: unknown = { jobId: "job-s", state: "queued" }) {
  vi.mocked(connectDaemonIfRunning).mockResolvedValue({
    addr: { baseUrl: "http://fixture", token: "fixture" },
  } as never);
  vi.mocked(controlApiFetch).mockResolvedValue({
    ok: true,
    status: 202,
    json: async () => body,
  } as never);
}

describe("MCP sparse continuation query", () => {
  afterEach(() => vi.resetAllMocks());

  it.each([undefined, "", "keep going"])(
    "posts only continuation fields with prompt %j, without runner defaults",
    async (prompt) => {
      connected();
      const result = await mcpSurfaceRunner()({
        mode: "__run_continue",
        runId: "run-p",
        ...(prompt !== undefined ? { prompt } : {}),
        idempotencyKey: "stable-key",
      });
      expect(controlApiFetch).toHaveBeenCalledExactlyOnceWith(expect.anything(), "/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "stable-key" },
        body: JSON.stringify({
          continueFrom: "run-p",
          ...(prompt !== undefined ? { prompt } : {}),
        }),
      });
      expect(result).toMatchObject({ jobId: "job-s", runId: "", status: "queued" });
      expect(enqueueAndAwait).not.toHaveBeenCalled();
      expect(ensureDaemon).not.toHaveBeenCalled();
    },
  );

  it("returns bound run handles without polling or inventing lifecycle", async () => {
    connected({ jobId: "job-s", runId: "run-s", taskId: "task-s", runDir: "/fixture/run-s" });
    const result = await runContinueQuery({ runId: "run-p" });
    expect(result).toMatchObject({ jobId: "job-s", runId: "run-s", runDir: "/fixture/run-s" });
    // No state read is available here: the lifecycle stays unknown, never assumed running.
    expect(result).toMatchObject({ status: "" });
    expect(result).not.toHaveProperty("state");
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
  });

  it("forwards explicit successor controls verbatim and omits absent ones", async () => {
    connected();
    const controls = {
      access: "readonly",
      web: "off",
      externalContextPolicy: "off",
      credentialProfileId: "codex-work",
      paidBudget: { kind: "finite", maxUsd: 0 },
      maxSeconds: 600,
      timeLimitMode: "soft",
      review: true,
      reviewerPanel: [{ harness: "claude" }],
      reviewerModels: { anthropic: "fixture-model" },
      reviewerEfforts: { openai: "high" },
      continueCarrier: "packet",
    };
    await runContinueQuery({ runId: "run-p", prompt: "", ...controls, idempotencyKey: "k" });
    expect(JSON.parse(String(vi.mocked(controlApiFetch).mock.calls[0]![2]!.body))).toEqual({
      continueFrom: "run-p",
      prompt: "",
      ...controls,
    });
    vi.mocked(controlApiFetch).mockClear();
    await runContinueQuery({ runId: "run-p", review: false });
    expect(JSON.parse(String(vi.mocked(controlApiFetch).mock.calls[0]![2]!.body))).toEqual({
      continueFrom: "run-p",
      review: false,
    });
  });

  it.each([
    { access: "full_access" },
    { web: "sometimes" },
    { paidBudget: { kind: "finite" } },
    { maxSeconds: 0 },
    { continueCarrier: "native" },
    { reviewerPanel: [] },
    { harnesses: ["claude"] },
    { model: "m" },
    { execution: { isolation: "live" } },
  ])(
    "refuses a control outside the canonical successor contract %j before connection",
    async (extra) => {
      await expect(runContinueQuery({ runId: "run-p", ...extra })).rejects.toBeDefined();
      expect(connectDaemonIfRunning).not.toHaveBeenCalled();
    },
  );

  it("returns a successor that failed before its run started as a typed job handle", async () => {
    connected();
    vi.mocked(controlApiFetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          code: "credential_profile_unknown",
          message: "profile p1 is unknown",
          retryable: false,
          requiredActions: [],
          context: { jobId: "job-f", state: "failed" },
        }),
      } as never)
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) } as never);
    expect(await runContinueQuery({ runId: "run-p", credentialProfileId: "p1" })).toMatchObject({
      jobId: "job-f",
      runId: "",
      status: "failed",
      summary: "profile p1 is unknown",
    });
    // The detail read addresses the unbound job by its job id.
    expect(vi.mocked(controlApiFetch).mock.calls[1]![1]).toBe("/runs/job-f");
  });

  it("does not start a missing daemon", async () => {
    vi.mocked(connectDaemonIfRunning).mockResolvedValue(null);
    await expect(runContinueQuery({ runId: "run-p" })).rejects.toMatchObject({
      code: "daemon_unavailable",
      retryable: true,
    });
    expect(ensureDaemon).not.toHaveBeenCalled();
    expect(controlApiFetch).not.toHaveBeenCalled();
  });

  it("blocks bound Delegate contexts and explicit lineage before connecting", async () => {
    await expect(
      mcpSurfaceRunner({ delegationParentRunId: "parent" })({
        mode: "__run_continue",
        runId: "run-p",
      }),
    ).rejects.toMatchObject({ code: "delegation_forbidden" });
    await expect(
      runContinueQuery({ runId: "run-p", delegatedFromRunId: "parent" }),
    ).rejects.toMatchObject({ code: "delegation_forbidden" });
    expect(connectDaemonIfRunning).not.toHaveBeenCalled();
  });

  it.each([
    ["predecessor_unknown", 404],
    ["predecessor_live", 409],
    ["continue_from_unsupported", 400],
    ["continuation_superseded", 409],
    ["run_artifacts_expired", 410],
    ["continuation_predecessor_unavailable", 404],
  ])("preserves %s without retrying", async (code, status) => {
    connected();
    vi.mocked(controlApiFetch).mockResolvedValue({
      ok: false,
      status,
      json: async () => ({
        code,
        message: "engine refusal",
        retryable: false,
        context: { head: "run-head" },
        requiredActions: ["Inspect the predecessor."],
      }),
    } as never);
    await expect(runContinueQuery({ runId: "run-p" })).rejects.toMatchObject({
      code,
      retryable: false,
      context: { head: "run-head" },
      requiredActions: ["Inspect the predecessor."],
    });
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
  });

  it.each([{ runId: "" }, { runId: "run-p", prompt: 1 }, { runId: "run-p", idempotencyKey: "" }])(
    "rejects invalid input %j before connection",
    async (input) => {
      await expect(runContinueQuery(input)).rejects.toBeDefined();
      expect(connectDaemonIfRunning).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid successful response", async () => {
    connected({ state: "queued" });
    await expect(runContinueQuery({ runId: "run-p" })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});
