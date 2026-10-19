import { afterEach, describe, expect, it, vi } from "vitest";
import { runContinueQuery } from "./mcp-run-continue.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";
import { connectDaemonIfRunning, enqueueAndAwait, ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";

vi.mock("./daemon-run.js", () => ({
  connectDaemonIfRunning: vi.fn(),
  ensureDaemon: vi.fn(),
  enqueueAndAwait: vi.fn(),
}));
vi.mock("./live.js", () => ({ controlApiFetch: vi.fn() }));

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
      expect(result).toMatchObject({ jobId: "job-s", state: "queued" });
      expect(enqueueAndAwait).not.toHaveBeenCalled();
      expect(ensureDaemon).not.toHaveBeenCalled();
    },
  );

  it("returns bound run handles without polling or inventing lifecycle", async () => {
    connected({ jobId: "job-s", runId: "run-s", taskId: "task-s", runDir: "/fixture/run-s" });
    const result = await runContinueQuery({ runId: "run-p" });
    expect(result).toMatchObject({ jobId: "job-s", runId: "run-s", runDir: "/fixture/run-s" });
    expect(result).not.toHaveProperty("state");
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
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
