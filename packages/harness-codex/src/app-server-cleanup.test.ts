import {
  WINDOWS_TREE_DEATH_PROOF_UNAVAILABLE,
  type ProcEvent,
  type spawnProcess,
} from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { describe, expect, it } from "vitest";
import { runCodexAppServer } from "./app-server-run.js";

type Cleanup = Extract<ProcEvent, { type: "termination_unconfirmed" }>;
const limitation: Cleanup = {
  type: "termination_unconfirmed",
  rootPid: 42,
  survivors: [],
  unresolved: [{ pgid: 42, reason: WINDOWS_TREE_DEATH_PROOF_UNAVAILABLE }],
};

type Scenario = {
  text?: string;
  status?: string | null;
  cleanup?: Cleanup;
  systemError?: boolean;
  malformed?: boolean;
  stopFrames?: unknown[];
  cancelAt?: "before-terminal" | "during-stop" | "after-cleanup";
};

// The real adapter owns completion, lifecycle, cancellation and final extraction.
// Only process I/O is controlled; the cleanup event is the production producer's shape.
async function collect(s: Scenario = {}): Promise<HarnessEvent[]> {
  const replies: string[] = [];
  const externalAbort = new AbortController();
  let wake: (() => void) | undefined;
  let stopped = false;
  const push = (value: unknown): void => {
    replies.push(JSON.stringify(value));
    wake?.();
    wake = undefined;
  };
  const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
    options.onSpawn?.({
      write(data) {
        const request = JSON.parse(data) as { id?: number; method: string };
        if (request.method === "initialize") push({ id: request.id, result: {} });
        if (request.method === "thread/start") {
          push({ id: request.id, result: { thread: { id: "root" } } });
          push({
            method: "mcpServer/startupStatus/updated",
            params: { threadId: "root", name: "required", status: "ready" },
          });
        }
        if (request.method === "turn/start") {
          push({ id: request.id, result: { turn: { id: "turn" } } });
          push({ method: "turn/started", params: { threadId: "root", turn: { id: "turn" } } });
          if (s.malformed) replies.push("not-json");
          if (s.text !== "")
            push({
              method: "item/completed",
              params: {
                threadId: "root",
                turnId: "turn",
                item: { type: "agentMessage", id: "answer", text: s.text ?? '{"verdict":"PASS"}' },
              },
            });
          if (s.cancelAt === "before-terminal") externalAbort.abort();
          push({
            method: "turn/completed",
            params: {
              threadId: "root",
              turn: {
                id: "turn",
                ...(s.status === null ? {} : { status: s.status ?? "completed" }),
                items: [],
              },
            },
          });
        }
        if (request.method === "thread/read")
          push({
            id: request.id,
            result: { thread: { status: { type: s.systemError ? "systemError" : "idle" } } },
          });
        if (request.method === "thread/goal/get") push({ id: request.id, result: { goal: null } });
        if (request.method === "thread/backgroundTerminals/list")
          push({ id: request.id, result: { data: [] } });
        if (request.method === "turn/interrupt") {
          push({ id: request.id, result: {} });
          push({
            method: "turn/completed",
            params: { threadId: "root", turn: { id: "turn", status: "interrupted", items: [] } },
          });
        }
      },
      end() {
        stopped = true;
        for (const frame of s.stopFrames ?? []) push(frame);
        wake?.();
      },
      closed: Promise.resolve(),
    });
    options.abortSignal?.addEventListener(
      "abort",
      () => {
        stopped = true;
        wake?.();
      },
      { once: true },
    );
    while (!stopped || replies.length) {
      if (replies.length) yield { type: "stdout", line: replies.shift()! };
      else
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
    if (s.cancelAt === "during-stop") externalAbort.abort();
    yield { type: "exit", code: null, signal: "SIGINT" };
    yield s.cleanup ?? limitation;
    if (s.cancelAt === "after-cleanup") externalAbort.abort();
  };
  const events: HarnessEvent[] = [];
  for await (const event of runCodexAppServer({
    bin: "codex",
    args: [],
    env: {},
    spawn,
    pollIntervalMs: 0,
    spec: {
      ...HarnessRunSpec.parse({
        session_id: "cleanup",
        intent: "implement",
        prompt: "review",
        cwd: process.cwd(),
        extra_mcp_servers: [
          { name: "required", command: "unused-fixture", args: [], required: true },
        ],
      }),
      extra: { abortSignal: externalAbort.signal },
    },
  }))
    events.push(event);
  return events;
}

describe("Codex normal completion versus cleanup uncertainty", () => {
  it.each([
    {
      method: "thread/status/changed",
      params: { threadId: "root", status: { type: "systemError" } },
    },
    {
      method: "mcpServer/startupStatus/updated",
      params: { threadId: "root", name: "required", status: "failed" },
    },
    {
      method: "turn/completed",
      params: { threadId: "root", turn: { id: "turn", status: "failed" } },
    },
    { method: "turn/started", params: { threadId: "root", turn: { id: "late" } } },
  ])("rejects late root $method during shutdown", async (frame) => {
    const events = await collect({ stopFrames: [frame] });
    expect(events.some((e) => e.final)).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
  it("does not promote a late subagent failure to a root failure", async () => {
    const events = await collect({
      stopFrames: [
        {
          method: "thread/status/changed",
          params: { threadId: "child", status: { type: "systemError" } },
        },
      ],
    });
    expect(events.some((e) => e.final)).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
  it.each(['{"verdict":"PASS"}', '{"verdict":"FAIL","finding":"defect"}'])(
    "preserves the completed review text unchanged: %s",
    async (text) => {
      const events = await collect({ text });
      expect(events.filter((e) => e.final).map((e) => e.text)).toEqual([text]);
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(events.filter((e) => e.type === "completed")).toHaveLength(1);
      expect(events.at(-1)?.payload?.["termination_unconfirmed"]).toEqual({
        survivors: [],
        unresolved: limitation.unresolved,
      });
    },
  );
  it.each([
    { name: "survivor", cleanup: { ...limitation, survivors: [43] } },
    {
      name: "other reason",
      cleanup: { ...limitation, unresolved: [{ pgid: 42, reason: "identity_unavailable" }] },
    },
    {
      name: "mixed reason",
      cleanup: {
        ...limitation,
        unresolved: [...limitation.unresolved, { pgid: 43, reason: "identity_unavailable" }],
      },
    },
    { name: "empty evidence", cleanup: { ...limitation, unresolved: [] } },
    { name: "failed native turn", status: "failed" },
    { name: "interrupted native turn", status: "interrupted" },
    { name: "unknown native status", status: "future-status" },
    { name: "missing native status", status: null },
    { name: "no answer", text: "" },
    { name: "system error", systemError: true },
  ])("keeps $name outside the exception", async (scenario) => {
    const events = await collect(scenario);
    expect(events.some((e) => e.final)).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.at(-1)?.payload?.["termination_unconfirmed"]).toBeTruthy();
  });
  it("preserves an independent protocol failure without inventing a cleanup event", async () => {
    const events = await collect({ malformed: true });
    expect(events.some((e) => e.final)).toBe(false);
    expect(events.find((e) => e.type === "error")?.error).toContain(
      "Invalid Codex app-server frame",
    );
  });
  it.each(["before-terminal", "during-stop", "after-cleanup"] as const)(
    "does not promote cancellation %s",
    async (cancelAt) => {
      const events = await collect({ cancelAt });
      expect(events.some((e) => e.final)).toBe(false);
      expect(events.at(-1)?.aborted).toBe(true);
      expect(events.some((e) => e.type === "error")).toBe(true);
    },
  );
});
