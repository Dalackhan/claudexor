import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlRunStartRequest } from "@claudexor/schema";
import * as daemonRun from "./daemon-run.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";

afterEach(() => vi.restoreAllMocks());

describe("one-shot MCP launch idempotency transport", () => {
  it.each([
    { mode: "ask" },
    { mode: "agent" },
    { mode: "plan" },
    { mode: "agent", race: true },
    { mode: "agent", create: true },
  ])("passes the caller key separately from the strict run body: %j", async (strategy) => {
    vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://unused", token: "fixture" },
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const enqueue = vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
      runId: "run-key",
      jobId: "job-key",
      runDir: "",
      status: "running",
    });
    await mcpSurfaceRunner()({
      ...strategy,
      prompt: "inspect",
      deferred: true,
      idempotencyKey: "caller-key",
      parentRunId: "forged",
      delegatedFromRunId: "forged",
      internalDaemonEnqueue: true,
    });
    const [, , body, options] = enqueue.mock.calls[0]!;
    expect(options).toMatchObject({ waitForTerminal: false, idempotencyKey: "caller-key" });
    expect(options).not.toHaveProperty("internalDaemonEnqueue");
    expect(body).not.toHaveProperty("idempotencyKey");
    expect(ControlRunStartRequest.safeParse(body).success).toBe(true);
    expect(body).not.toHaveProperty("parentRunId");
    expect(body).not.toHaveProperty("delegatedFromRunId");
  });

  it("passes a bound belt's caller key to the explicit internal-path refusal", async () => {
    const client = { enqueue: vi.fn() };
    vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
      client: client as never,
      addr: { baseUrl: "http://unused", token: "fixture" },
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    await expect(
      mcpSurfaceRunner({
        requireExistingDaemon: true,
        delegationParentRunId: "parent",
        delegationRepoRoot: "/bound",
      })({ mode: "ask", prompt: "inspect", idempotencyKey: "caller-key" }),
    ).rejects.toMatchObject({ code: "delegation_idempotency_unsupported", retryable: false });
    expect(client.enqueue).not.toHaveBeenCalled();
  });
});
