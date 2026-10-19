/** The controller lifecycle over the built MCP transport and a disposable daemon. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { CLI, makeSandbox, type Sandbox } from "./support.js";

let sandbox: Sandbox | undefined;
afterEach(() => {
  sandbox?.dispose();
  sandbox = undefined;
});

function controller(sb: Sandbox) {
  const child = spawn(process.execPath, [CLI, "mcp", "serve"], {
    cwd: sb.repo,
    env: sb.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let nextId = 0;
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  child.once("exit", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`MCP exited: ${stderr}`));
    }
    pending.clear();
  });
  function request(method: string, params?: unknown) {
    const id = ++nextId;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request ${method} timed out: ${stderr}`));
      }, 60_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  return {
    request,
    async initialize() {
      await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "supervision-canary", version: "1.0" },
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
      );
    },
    async call(name: string, args: Record<string, unknown>) {
      return request("tools/call", { name, arguments: args });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGTERM"), 2000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
        lines.close();
      }
    },
  };
}

it("[INV-002:mcp-supervision] replays one launch, observes, steers and continues without duplicating work", async () => {
  sandbox = makeSandbox();
  const mcp = controller(sandbox);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await mcp.call(name, args);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toBeDefined();
    return result.structuredContent as Record<string, any>;
  };
  const observeUntil = async (
    runId: string,
    predicate: (result: Record<string, any>) => boolean,
  ) => {
    let cursor = 0;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const result = await call("claudexor_run_wait", {
        runId,
        afterSeq: cursor,
        waitMs: 1000,
        maxEvents: 50,
      });
      if (predicate(result)) return result;
      cursor = result.nextSeq;
    }
    throw new Error(`run ${runId} did not reach the expected observation`);
  };
  const parked = (result: Record<string, any>) =>
    result.events?.some(
      ({ event }: any) =>
        event.type === "harness.event" &&
        event.payload?.text?.includes("waiting for a live message"),
    );
  const terminal = (result: Record<string, any>) =>
    ["succeeded", "failed", "cancelled", "interrupted"].includes(result.status);
  try {
    await mcp.initialize();
    const listed = await mcp.request("tools/list");
    expect(listed.tools.map((tool: any) => tool.name)).toEqual(
      expect.arrayContaining([
        "claudexor_run_wait",
        "claudexor_run_message",
        "claudexor_run_continue",
      ]),
    );
    const launch = {
      prompt: "Wait for the controller message, then finish.",
      repoPath: sandbox.repo,
      harness: "fake-steerable",
      access: "readonly",
      idempotencyKey: "supervision-launch",
    };
    const first = await call("claudexor_ask", launch);
    const replay = await call("claudexor_ask", launch);
    expect(replay.runId).toBe(first.runId);
    const conflict = await mcp.call("claudexor_ask", { ...launch, prompt: "A different task" });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict)).toContain("idempotency_conflict");
    await observeUntil(first.runId, parked);
    const message = {
      runId: first.runId,
      text: "Use MANGO.",
      idempotencyKey: "supervision-message",
    };
    const receipt = await call("claudexor_run_message", message);
    expect(["accepted", "delivered"]).toContain(receipt.outcome);
    expect(receipt.messageId).toBe(message.idempotencyKey);
    expect(await call("claudexor_run_message", message)).toEqual(receipt);
    const finished = await observeUntil(first.runId, terminal);
    expect(finished.status).toBe("succeeded");
    const continuedRequest = {
      runId: first.runId,
      prompt: "",
      idempotencyKey: "supervision-continue",
    };
    const continued = await call("claudexor_run_continue", continuedRequest);
    const continuedReplay = await call("claudexor_run_continue", continuedRequest);
    expect(continuedReplay.jobId ?? continuedReplay.runId).toBe(continued.jobId ?? continued.runId);
    const successor = continued.runId ?? continued.jobId;
    expect(successor).toBeTruthy();
    expect(successor).not.toBe(first.runId);
    await observeUntil(successor, parked);
    await call("claudexor_run_message", {
      runId: successor,
      text: "Use MANGO again.",
      idempotencyKey: "supervision-successor-message",
    });
    expect((await observeUntil(successor, terminal)).status).toBe("succeeded");
    const superseded = await mcp.call("claudexor_run_continue", {
      runId: first.runId,
      idempotencyKey: "another-successor",
    });
    expect(superseded.isError).toBe(true);
    expect(JSON.stringify(superseded)).toContain("continuation_superseded");
  } finally {
    await mcp.close();
  }
}, 180_000);
