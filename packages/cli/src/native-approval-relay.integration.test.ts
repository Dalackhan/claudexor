import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { spawnProcess } from "@claudexor/core";
import {
  createPartition,
  createSqlDaemonServices,
  DaemonClient,
  DaemonServer,
  EngineStore,
  setGlobalGenerationInTx,
  type RunnerFn,
} from "@claudexor/daemon";
import { DaemonControlApiServer } from "@claudexor/control-api";
import { defaultClaudexorTools, serveClaudexorMcp } from "@claudexor/mcp-server";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
// The built module: the orchestrator channel types its log against @claudexor/event-log.
import { EventLog } from "../../event-log/dist/index.js";
import { runCodexAppServer } from "../../harness-codex/src/app-server-run.js";
import { interactionChannelFor } from "../../orchestrator/src/interaction.js";
import * as daemonRun from "./daemon-run.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";
import { createRunTimeLimit } from "./run-time-limit.js";

type Frame = Record<string, unknown>;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** A Codex app-server root thread whose turns the test scripts frame by frame. */
function codexPeer(cwd: string) {
  const writes: Frame[] = [];
  const frames: string[] = [];
  const turnStarts: Array<(id: string) => void> = [];
  let turns = 0;
  let wake: (() => void) | undefined;
  let stopped = false;
  let close!: () => void;
  const closed = new Promise<void>((done) => (close = done));
  const push = (frame: Frame) => {
    frames.push(JSON.stringify(frame));
    wake?.();
    wake = undefined;
  };
  const written = (match: (frame: Frame) => boolean) =>
    vi.waitFor(
      () => {
        const frame = writes.find(match);
        expect(frame).toBeDefined();
        return frame!;
      },
      { timeout: 5_000, interval: 10 },
    );
  const finishTurn = (turnId: string, text: string) => {
    push({
      method: "item/completed",
      params: {
        threadId: "root",
        turnId,
        item: { id: `msg-${turnId}`, type: "agentMessage", text },
      },
    });
    push({
      method: "turn/completed",
      params: { threadId: "root", turn: { id: turnId, status: "completed", items: [] } },
    });
  };
  const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
    options.onSpawn?.({
      write(line) {
        const frame = JSON.parse(line) as Frame;
        writes.push(frame);
        const method = frame["method"];
        if (method === "initialize") push({ id: frame["id"], result: {} });
        if (method === "thread/start")
          push({ id: frame["id"], result: { thread: { id: "root" } } });
        if (method === "turn/start") {
          turns += 1;
          const turnId = `turn-${turns}`;
          push({ method: "turn/started", params: { threadId: "root", turn: { id: turnId } } });
          push({ id: frame["id"], result: { turn: { id: turnId } } });
          turnStarts.shift()?.(turnId);
        }
        if (method === "thread/approveGuardianDeniedAction") push({ id: frame["id"], result: {} });
        if (method === "thread/read")
          push({ id: frame["id"], result: { thread: { status: { type: "idle" } } } });
        if (method === "thread/goal/get")
          push({ id: frame["id"], result: { goal: { status: "complete" } } });
        if (method === "thread/backgroundTerminals/list")
          push({ id: frame["id"], result: { data: [] } });
        if (method === "turn/interrupt") push({ id: frame["id"], result: {} });
      },
      end() {
        stopped = true;
        close();
        wake?.();
      },
      closed,
    });
    while (!stopped || frames.length) {
      if (frames.length) yield { type: "stdout", line: frames.shift()! };
      else await new Promise<void>((done) => (wake = done));
    }
    yield { type: "exit", code: 0, signal: null, durationMs: 0 };
  };
  return {
    cwd,
    spawn,
    writes,
    push,
    written,
    finishTurn,
    /** Resolves with the id of the next root turn the adapter starts. */
    nextTurn: () => new Promise<string>((done) => turnStarts.push(done)),
    fileApproval(turnId: string, requestId: string) {
      push({
        method: "item/started",
        params: {
          threadId: "root",
          turnId,
          item: {
            id: `item-${requestId}`,
            type: "fileChange",
            changes: [{ path: "smoke.txt", kind: { type: "add" }, diff: "+exact bytes\n" }],
          },
        },
      });
      push({
        id: requestId,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "root",
          turnId,
          itemId: `item-${requestId}`,
          reason: "write outside the base sandbox",
        },
      });
    },
    autoReviewDenial(turnId: string, reviewId: string) {
      push({
        method: "item/autoApprovalReview/completed",
        params: {
          threadId: "root",
          turnId,
          reviewId,
          targetItemId: "item-command",
          action: { type: "command", source: "shell", command: "node --test", cwd },
          review: { status: "denied", rationale: "Needs explicit authorization" },
          startedAtMs: 100,
          completedAtMs: 200,
          decisionSource: "agent",
        },
      });
    },
  };
}

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-nar-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const store = await EngineStore.open({
    daemonDir: root,
    workerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
  });
  cleanups.push(() => store.close());
  store.transaction(() => {
    const global = createPartition(store, "global");
    setGlobalGenerationInTx(store, global.pid);
  });
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [] });
  cleanups.push(() => graph.close());
  const peer = codexPeer(workspace);
  const harnessEvents: HarnessEvent[] = [];
  const abortReasons: unknown[] = [];
  const runner: RunnerFn = async (params, ctx) => {
    const runId = `run-${ctx.jobId}`;
    const taskId = `task-${ctx.jobId}`;
    const runDir = join(root, runId);
    mkdirSync(runDir);
    // The production run-owned clock: one stable signal for the whole run.
    const limit = createRunTimeLimit(params as { maxSeconds?: number }, ctx);
    ctx.onRunStart({ runId, taskId, runDir });
    limit.started({ runId, taskId, runDir });
    // The orchestrator's own channel, bound to the daemon's durable registry.
    const channel = interactionChannelFor(
      {
        onInteraction: (pending) => graph.interactions.register(pending, params),
        interactionTimeoutMs: null,
        signal: limit.signal,
      },
      new EventLog(join(runDir, "events.jsonl"), runId, taskId),
      runId,
      taskId,
      "a01",
      "codex",
      true,
    );
    const spec = HarnessRunSpec.parse({
      session_id: runId,
      intent: "implement",
      prompt: "Make the change and verify it",
      cwd: workspace,
      access: "workspace_write",
    });
    spec.extra["interactionChannel"] = channel;
    spec.extra["abortSignal"] = limit.signal;
    try {
      for await (const event of runCodexAppServer({
        bin: "codex",
        args: [],
        spec,
        env: {},
        spawn: peer.spawn,
        pollIntervalMs: 5,
      }))
        harnessEvents.push(event);
    } finally {
      if (limit.signal.aborted) abortReasons.push(limit.signal.reason);
      limit.dispose();
    }
    // Fixture-only lifecycle reduction; the orchestrator owns real outcome facts.
    const aborted = limit.signal.aborted || harnessEvents.at(-1)?.aborted === true;
    const failed = harnessEvents.some((event) => event.type === "error");
    return {
      lifecycle: aborted ? "cancelled" : failed ? "failed" : "succeeded",
      summary: "native relay fixture",
    };
  };
  const socketPath = join(root, "d.sock");
  const daemon = new DaemonServer({
    socketPath,
    token: "fixture",
    commands: graph.commands,
    runner,
    onRunTerminal: (runId) => graph.interactions.dropForRun(runId),
  });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  const client = new DaemonClient(socketPath, "fixture");
  const control = new DaemonControlApiServer({
    token: "fixture",
    daemon: client,
    services: {
      pendingInteractions: (runId) => graph.interactions.pendingForRun(runId),
      answerInteraction: (runId, interactionId, answers) =>
        graph.interactions.answer(runId, interactionId, answers),
    },
  } as ConstructorParameters<typeof DaemonControlApiServer>[0]);
  const { host, port } = await control.start();
  cleanups.push(() => control.stop());
  const baseUrl = `http://${host}:${port}`;
  const headers = { authorization: "Bearer fixture", "X-Claudexor-Protocol-Major": "3" };
  const http = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}/v2${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  // The real MCP surface runner, pointed at this daemon's control API.
  vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
    client: client as never,
    addr: { baseUrl, token: "fixture" },
    engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" } as never,
  });
  const started = async (extra: Record<string, unknown> = {}) => {
    const accepted = await client.enqueue({ prompt: "native relay fixture", ...extra });
    const record = await vi.waitFor(
      async () => {
        const current = await client.status(accepted.id);
        expect(current).toMatchObject({ state: "running", runId: `run-${accepted.id}` });
        return current;
      },
      { timeout: 5_000, interval: 10 },
    );
    return { id: accepted.id, runId: record.runId!, runDir: record.runDir! };
  };
  const terminal = (id: string) =>
    vi.waitFor(
      async () => {
        const record = await client.status(id);
        expect(["succeeded", "failed", "cancelled"]).toContain(record.state);
        return record;
      },
      { timeout: 5_000, interval: 10 },
    );
  const pending = (runId: string, count: number) =>
    vi.waitFor(
      async () => {
        const detail = await http("GET", `/runs/${encodeURIComponent(runId)}`);
        expect(detail.status).toBe(200);
        expect(detail.body.pendingInteractions).toHaveLength(count);
        return detail.body.pendingInteractions as Array<Record<string, any>>;
      },
      { timeout: 5_000, interval: 10 },
    );
  return { peer, http, started, terminal, pending, harnessEvents, abortReasons };
}

function mcpWire() {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const handle = serveClaudexorMcp({
    version: "0.0.0-test",
    tools: defaultClaudexorTools(mcpSurfaceRunner()),
    transport: { read: c2s, write: s2c },
  });
  const lines = createInterface({ input: s2c });
  const replies = new Map<number, (reply: any) => void>();
  lines.on("line", (line) => {
    const reply = JSON.parse(line);
    if (typeof reply.id === "number") replies.get(reply.id)?.(reply);
  });
  let nextId = 0;
  const call = (method: string, params: unknown): Promise<any> =>
    new Promise((done) => {
      const id = ++nextId;
      replies.set(id, done);
      c2s.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  cleanups.push(async () => {
    await handle.close();
    lines.close();
    c2s.destroy();
    s2c.destroy();
  });
  return {
    async start() {
      await call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "relay-fixture", version: "1.0" },
      });
      c2s.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    tool: (name: string, args: Record<string, unknown>) =>
      call("tools/call", { name, arguments: args }),
  };
}

const answerBody = (questionId: string, label: string) => ({
  answers: [{ questionId, selectedLabels: [label] }],
});

const decisionsFor = (writes: Frame[], requestId: string) =>
  writes.filter((frame) => frame["id"] === requestId && frame["method"] === undefined);

describe("native Codex approvals through the existing interaction surfaces", () => {
  it("answers one exact pending action over HTTP once, and refuses a duplicate answer", async () => {
    const f = await fixture();
    const turn = f.peer.nextTurn();
    const run = await f.started();
    const turnId = await turn;
    f.peer.fileApproval(turnId, "srv-file");
    const [interaction] = await f.pending(run.runId, 1);
    const question = interaction!.questions[0];
    expect(question.question).toContain("smoke.txt");
    expect(question.question).toContain("+exact bytes");
    expect(question.question).toContain("No session-wide permission");
    expect(question.options.map((option: { label: string }) => option.label)).toEqual([
      "Approve once",
      "Decline",
    ]);
    const path = `/runs/${run.runId}/interactions/${interaction!.interactionId}/answer`;
    expect(await f.http("POST", path, answerBody(question.id, "Approve once"))).toMatchObject({
      status: 200,
      body: { accepted: true, status: "delivered" },
    });
    await f.peer.written((frame) => frame["id"] === "srv-file" && frame["method"] === undefined);
    expect(decisionsFor(f.peer.writes, "srv-file")).toEqual([
      { id: "srv-file", result: { decision: "accept" } },
    ]);
    expect(await f.http("POST", path, answerBody(question.id, "Approve once"))).toMatchObject({
      status: 409,
      body: { context: { accepted: false, status: "already_resolved" } },
    });
    f.peer.finishTurn(turnId, "Wrote smoke.txt");
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    expect(decisionsFor(f.peer.writes, "srv-file")).toHaveLength(1);
    expect(JSON.stringify(f.peer.writes)).not.toMatch(/acceptForSession|acceptWithExecpolicy/);
    const events = readFileSync(join(run.runDir, "events.jsonl"), "utf8");
    expect(events).toContain("interaction.answered");
  }, 20_000);

  it("revokes a native request the app-server resolved itself and refuses the late answer", async () => {
    const f = await fixture();
    const turn = f.peer.nextTurn();
    const run = await f.started();
    const turnId = await turn;
    f.peer.fileApproval(turnId, "srv-revoked");
    const [interaction] = await f.pending(run.runId, 1);
    f.peer.push({
      method: "serverRequest/resolved",
      params: { threadId: "root", requestId: "srv-revoked" },
    });
    await f.pending(run.runId, 0);
    const late = await f.http(
      "POST",
      `/runs/${run.runId}/interactions/${interaction!.interactionId}/answer`,
      answerBody(interaction!.questions[0].id, "Approve once"),
    );
    expect(late).toMatchObject({
      status: 409,
      body: { context: { accepted: false, status: "already_resolved" } },
    });
    f.peer.finishTurn(turnId, "Continued without the write");
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    expect(decisionsFor(f.peer.writes, "srv-revoked")).toEqual([]);
    // The durable per-run stream announces the withdrawal answer surfaces close on.
    const events = readFileSync(join(run.runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    expect(
      events.filter(
        (event) =>
          event.type.startsWith("interaction.") &&
          event.payload["interaction_id"] === interaction!.interactionId,
      ),
    ).toEqual([
      expect.objectContaining({ type: "interaction.requested" }),
      expect.objectContaining({ type: "interaction.withdrawn" }),
    ]);
  }, 20_000);

  it("lets an MCP controller authorize one denied-action retry, keeping both turns' answers", async () => {
    const f = await fixture();
    const mcp = mcpWire();
    await mcp.start();
    const first = f.peer.nextTurn();
    const run = await f.started();
    const firstTurn = await first;
    f.peer.autoReviewDenial(firstTurn, "review-1");
    f.peer.finishTurn(firstTurn, "Blocked: node --test needs permission");
    await f.pending(run.runId, 1);
    const listed = await mcp.tool("claudexor_run_interactions", { runId: run.runId });
    const interaction = listed.result.structuredContent.interactions[0];
    const question = interaction.questions[0];
    expect(question.question).toContain('"command": "node --test"');
    expect(question.question).toContain("Blocked: node --test needs permission");
    expect(question.options.map((option: { label: string }) => option.label)).toEqual([
      "Authorize one retry",
      "Decline",
    ]);
    const second = f.peer.nextTurn();
    const answered = await mcp.tool("claudexor_answer_interaction", {
      runId: run.runId,
      interactionId: interaction.interactionId,
      answers: [{ questionId: question.id, selectedLabels: ["Authorize one retry"] }],
    });
    expect(answered.result.isError).not.toBe(true);
    const secondTurn = await second;
    const authorization = await f.peer.written(
      (frame) => frame["method"] === "thread/approveGuardianDeniedAction",
    );
    expect(authorization["params"]).toMatchObject({
      threadId: "root",
      event: {
        id: "review-1",
        status: "denied",
        action: { type: "command", command: "node --test", cwd: f.peer.cwd },
      },
    });
    const retryStart = f.peer.writes.filter((frame) => frame["method"] === "turn/start")[1];
    expect(retryStart?.["params"]).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
    f.peer.finishTurn(secondTurn, "Verified after the authorized retry");
    expect((await f.terminal(run.id)).state).toBe("succeeded");
    expect(f.harnessEvents.filter((event) => event.final).map((event) => event.text)).toEqual([
      "Blocked: node --test needs permission",
      "Verified after the authorized retry",
    ]);
    const late = await mcp.tool("claudexor_answer_interaction", {
      runId: run.runId,
      interactionId: interaction.interactionId,
      answers: [{ questionId: question.id, selectedLabels: ["Authorize one retry"] }],
    });
    expect(late.result.isError).toBe(true);
    expect(
      f.peer.writes.filter((frame) => frame["method"] === "thread/approveGuardianDeniedAction"),
    ).toHaveLength(1);
  }, 20_000);

  it("releases a pending denial handback on Stop without authorizing it", async () => {
    const f = await fixture();
    const first = f.peer.nextTurn();
    const run = await f.started();
    const turnId = await first;
    f.peer.autoReviewDenial(turnId, "review-stop");
    f.peer.finishTurn(turnId, "Done except the denied check");
    const [interaction] = await f.pending(run.runId, 1);
    const stop = await f.http("POST", `/runs/${run.runId}/control`, {
      control: { kind: "cancel", reason: "fixture stop", reason_code: "user_cancelled" },
    });
    expect(stop.status).toBe(200);
    expect((await f.terminal(run.id)).state).toBe("cancelled");
    const late = await f.http(
      "POST",
      `/runs/${run.runId}/interactions/${interaction!.interactionId}/answer`,
      answerBody(interaction!.questions[0].id, "Authorize one retry"),
    );
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(late.body.context?.accepted ?? false).toBe(false);
    expect(
      f.peer.writes.some((frame) => frame["method"] === "thread/approveGuardianDeniedAction"),
    ).toBe(false);
    expect(f.peer.writes.filter((frame) => frame["method"] === "turn/start")).toHaveLength(1);
    expect(f.harnessEvents.filter((event) => event.final).map((event) => event.text)).toEqual([
      "Done except the denied check",
    ]);
    const events = readFileSync(join(run.runDir, "events.jsonl"), "utf8");
    expect(events).not.toContain('"type":"interaction.withdrawn"');
    expect(events).not.toContain('"reason":"request_withdrawn"');
  }, 20_000);

  it("lets a hard time limit stop the run while a native approval waits, without approving it", async () => {
    const f = await fixture();
    const turn = f.peer.nextTurn();
    const run = await f.started({ maxSeconds: 1 });
    const turnId = await turn;
    f.peer.fileApproval(turnId, "srv-deadline");
    const [interaction] = await f.pending(run.runId, 1);
    // Calendar time keeps running while the question waits for an answer.
    expect((await f.terminal(run.id)).state).toBe("cancelled");
    expect(f.abortReasons).toEqual(["wall_clock_exceeded"]);
    expect(decisionsFor(f.peer.writes, "srv-deadline")).toEqual([]);
    const late = await f.http(
      "POST",
      `/runs/${run.runId}/interactions/${interaction!.interactionId}/answer`,
      answerBody(interaction!.questions[0].id, "Approve once"),
    );
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(decisionsFor(f.peer.writes, "srv-deadline")).toEqual([]);
    const events = readFileSync(join(run.runDir, "events.jsonl"), "utf8");
    expect(events).toMatch(/"control":\{"kind":"time_limit","action":"reached"\}/);
    expect(events).not.toContain('"type":"interaction.withdrawn"');
    expect(events).not.toContain('"reason":"request_withdrawn"');
  }, 20_000);
});
