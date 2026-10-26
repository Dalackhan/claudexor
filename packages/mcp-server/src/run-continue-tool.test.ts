import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { defaultClaudexorTools, serveClaudexorMcp } from "./index.js";
import { beltClaudexorTools } from "./delegation-belt.js";
import { runContinueTool } from "./run-continue-tool.js";

describe("MCP run continuation", () => {
  it("registers a separate narrow mutating tool, absent from the Delegate belt", () => {
    const runner = vi.fn(async () => ({}));
    const tool = defaultClaudexorTools(runner).find((t) => t.name === "claudexor_run_continue")!;
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(["runId"]);
    // Explicit canonical successor controls; inherited groups are not restatable here.
    expect(
      Object.keys(tool.inputSchema.properties as object).filter((key) => key !== "taskGroupId"),
    ).toEqual([
      "runId",
      "prompt",
      "attachments",
      "idempotencyKey",
      "web",
      "externalContextPolicy",
      "paidBudget",
      "credentialProfileId",
      "access",
      "maxSeconds",
      "timeLimitMode",
      "review",
      "reviewerPanel",
      "reviewerModels",
      "reviewerEfforts",
      "continueCarrier",
    ]);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect((tool.inputSchema.properties as Record<string, unknown>)["attachments"]).toEqual(
      (
        defaultClaudexorTools(runner).find((candidate) => candidate.name === "claudexor_ask")!
          .inputSchema.properties as Record<string, unknown>
      )["attachments"],
    );
    expect(tool.inputSchema.required).not.toContain("attachments");
    expect((tool.inputSchema.properties as Record<string, unknown>)["taskGroupId"]).toMatchObject({
      type: "string",
      format: "uuid",
    });
    expect(tool.annotations?.readOnlyHint).toBe(false);
    expect(tool.outputSchema).toBeDefined();
    expect(
      beltClaudexorTools(runner, {
        parentRunId: "parent",
        repoRoot: "/fixture",
        depth: 0,
        maxSubRuns: 8,
        parentBudget: { kind: "unlimited" },
      }).some((t) => t.name === tool.name),
    ).toBe(false);
  });

  it("exposes optional group metadata only on public one-shot launch and continuation tools", () => {
    const runner = vi.fn(async () => ({}));
    const tools = defaultClaudexorTools(runner);
    for (const name of [
      "claudexor_ask",
      "claudexor_plan",
      "claudexor_run",
      "claudexor_best_of",
      "claudexor_run_continue",
    ]) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      expect(tool, name).toBeDefined();
      const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
      expect(properties["taskGroupId"], name).toMatchObject({ type: "string", format: "uuid" });
      expect(properties["taskGroupId"]).not.toHaveProperty("default");
      expect(tool.inputSchema.required ?? []).not.toContain("taskGroupId");
    }
    for (const tool of tools.filter((candidate) => candidate.name.startsWith("claudexor_thread_")))
      expect(tool.inputSchema.properties, tool.name).not.toHaveProperty("taskGroupId");
    const belt = beltClaudexorTools(runner, {
      parentRunId: "parent",
      repoRoot: "/fixture",
      depth: 0,
      maxSubRuns: 8,
      parentBudget: { kind: "unlimited" },
    });
    for (const tool of belt)
      expect(tool.inputSchema.properties, tool.name).not.toHaveProperty("taskGroupId");
  });

  it("mirrors the accepted grouped continuation receipt in both MCP channels", async () => {
    const taskGroupId = "11111111-1111-4111-8111-111111111111";
    const storeId = "22222222-2222-4222-8222-222222222222";
    const runner = vi.fn(async () => ({
      jobId: "job-s",
      runId: "",
      status: "queued",
      summary: "accepted",
      taskGroupId,
      storeId,
    }));
    const result = await runContinueTool(runner).handler(
      { runId: "run-p", taskGroupId, idempotencyKey: "group-key" },
      {},
    );
    expect(runner).toHaveBeenCalledExactlyOnceWith({
      mode: "__run_continue",
      runId: "run-p",
      taskGroupId,
      idempotencyKey: "group-key",
    });
    expect(result).toMatchObject({
      structured: { taskGroupId, storeId, jobId: "job-s", runId: null },
    });
    expect((result as { text: string }).text).toContain(`taskGroupId: ${taskGroupId}`);
    expect((result as { text: string }).text).toContain(`storeId: ${storeId}`);
  });

  it.each([undefined, "", "follow up"])(
    "keeps optional prompt %j and returns the durable handle",
    async (prompt) => {
      const runner = vi.fn(async () => ({
        jobId: "job-s",
        runId: "",
        status: "queued",
        summary: "job-s queued",
      }));
      const result = await runContinueTool(runner).handler(
        {
          runId: "run-p",
          ...(prompt !== undefined ? { prompt } : {}),
          idempotencyKey: "logical-call",
        },
        {},
      );
      expect(runner).toHaveBeenCalledWith({
        mode: "__run_continue",
        runId: "run-p",
        ...(prompt !== undefined ? { prompt } : {}),
        idempotencyKey: "logical-call",
      });
      expect(result).toMatchObject({
        structured: { jobId: "job-s", runId: null, status: "queued" },
      });
      expect((result as { text: string }).text).toContain("jobId: job-s");
    },
  );

  it("preserves the engine's refusal and chain head", async () => {
    const result = await runContinueTool(async () => {
      throw Object.assign(new Error("continue the head"), {
        code: "continuation_superseded",
        retryable: false,
        context: { runId: "run-p", head: "run-s" },
        requiredActions: ["Continue run-s."],
      });
    }).handler({ runId: "run-p" }, {});
    expect(result).toMatchObject({
      isError: true,
      structured: {
        failure: {
          code: "continuation_superseded",
          retryable: false,
          context: { runId: "run-p", head: "run-s" },
          requiredActions: ["Continue run-s."],
        },
      },
    });
  });

  it("accepts omitted/empty prompts on the SDK wire and refuses override knobs", async () => {
    const runner = vi.fn(async () => ({
      jobId: "job-s",
      runId: "",
      status: "queued",
      summary: "job-s queued",
    }));
    const input = new PassThrough();
    const output = new PassThrough();
    const server = serveClaudexorMcp({
      version: "0.0.0-test",
      tools: defaultClaudexorTools(runner),
      transport: { read: input, write: output },
    });
    const lines = createInterface({ input: output });
    const replies = new Map<number, any>();
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      replies.set(message.id, message);
    });
    let id = 0;
    const call = async (method: string, params: Record<string, unknown>) => {
      const requestId = ++id;
      input.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }) + "\n",
      );
      await vi.waitFor(() => expect(replies.has(requestId)).toBe(true));
      return replies.get(requestId);
    };
    try {
      await call("server/discover", {});
      for (const args of [{ runId: "run-p" }, { runId: "run-p", prompt: "" }]) {
        const reply = await call("tools/call", { name: "claudexor_run_continue", arguments: args });
        expect(reply.error).toBeUndefined();
        expect(reply.result).toMatchObject({
          structuredContent: { jobId: "job-s", runId: null, status: "queued" },
        });
      }
      expect(runner).toHaveBeenCalledTimes(2);
      const controls = {
        taskGroupId: "11111111-1111-4111-8111-111111111111",
        access: "readonly",
        web: "off",
        credentialProfileId: "codex-work",
        paidBudget: { kind: "finite", maxUsd: 0 },
        maxSeconds: 600,
        timeLimitMode: "soft",
        review: true,
        continueCarrier: "packet",
      };
      const accepted = await call("tools/call", {
        name: "claudexor_run_continue",
        arguments: { runId: "run-p", ...controls },
      });
      expect(accepted.result?.isError).not.toBe(true);
      expect(runner).toHaveBeenLastCalledWith({
        runId: "run-p",
        ...controls,
        mode: "__run_continue",
      });
      expect(runner).toHaveBeenCalledTimes(3);
      for (const attachments of [undefined, [], [{ resourceId: "res-document" }]]) {
        const args = {
          runId: "run-p",
          idempotencyKey: "document-successor",
          ...(attachments === undefined ? {} : { attachments }),
        };
        const reply = await call("tools/call", {
          name: "claudexor_run_continue",
          arguments: args,
        });
        expect(reply.error).toBeUndefined();
        expect(reply.result?.isError).not.toBe(true);
        expect(runner).toHaveBeenLastCalledWith({ ...args, mode: "__run_continue" });
      }
      expect(runner).toHaveBeenCalledTimes(6);
      for (const extra of [
        { taskGroupId: "not-a-uuid" },
        { taskGroupId: null },
        { execution: { isolation: "live" } },
        { access: "full_access" },
        { harness: "claude" },
        { model: "fixture-model" },
        { maxSeconds: 0 },
        { web: "on", externalContextPolicy: "off" },
        { prompt: null },
        { idempotencyKey: "" },
        { attachments: null },
        { attachments: [{ path: "/host/document.txt" }] },
        { attachments: [{ base64: "Zml4dHVyZQ==" }] },
        { attachments: [{ resourceId: "res-document", path: "/host/document.txt" }] },
        { attachments: [{ resourceId: "" }] },
        {
          attachments: [
            {
              resource_id: "res-document",
              kind: "file",
              mime: "text/plain",
              name: "document.txt",
              path: "/store/blob",
              sha256: `sha256:${"0".repeat(64)}`,
              size_bytes: 7,
            },
          ],
        },
      ]) {
        const reply = await call("tools/call", {
          name: "claudexor_run_continue",
          arguments: { runId: "run-p", ...extra },
        });
        expect(Boolean(reply.error) || reply.result?.isError === true).toBe(true);
      }
      expect(runner).toHaveBeenCalledTimes(6);
    } finally {
      await server.close();
      lines.close();
      input.destroy();
      output.destroy();
    }
  });
});
