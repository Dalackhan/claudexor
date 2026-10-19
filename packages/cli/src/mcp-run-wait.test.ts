import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpRunWaitResult } from "@claudexor/schema";
import { runWaitQuery } from "./mcp-run-wait.js";
import { connectDaemonIfRunning } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";

vi.mock("./daemon-run.js", () => ({ connectDaemonIfRunning: vi.fn() }));
vi.mock("./live.js", () => ({ controlApiFetch: vi.fn() }));

const interaction = {
  interactionId: "question-1",
  runId: "run-1",
  requestedAt: "2026-10-19",
  questions: [],
  timeoutAt: null,
};
const snapshot = (state = "running", lastSeq = 10, pendingInteractions: unknown[] = []) => ({
  summary: { id: "run-1", runId: "run-1", state },
  lastSeq,
  pendingInteractions,
});
const event = (seq: number, text = "hello") => ({
  seq,
  ts: "2026-10-19",
  run_id: "run-1",
  task_id: "task-1",
  type: "harness.event",
  payload: { text },
});
const frame = (seq: number, text?: string) =>
  `id: ${seq}\r\nevent: harness.event\r\ndata: ${JSON.stringify(event(seq, text))}\r\n\r\n`;

function fixture(chunks: string[], before = snapshot(), after = before, close = false) {
  const cancelled = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      if (close) controller.close();
    },
    cancel: cancelled,
  });
  let snapshots = 0;
  vi.mocked(controlApiFetch).mockImplementation(async (_addr, path, init) => {
    expect(init?.method ?? "GET").toBe("GET");
    if (path.endsWith("/events"))
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    return Response.json(snapshots++ === 0 ? before : after);
  });
  return { cancelled, stream };
}

describe("bounded durable run observation", () => {
  beforeEach(() => {
    vi.mocked(connectDaemonIfRunning).mockResolvedValue({
      addr: { baseUrl: "http://local", token: "test" },
    } as never);
  });
  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  it("replays sparse ids from Last-Event-ID across chunked CRLF frames", async () => {
    const bytes = frame(10) + frame(17) + frame(30);
    const { cancelled } = fixture([bytes.slice(0, 27), bytes.slice(27, -2), bytes.slice(-2)]);
    const result = await runWaitQuery({ runId: "run/1", afterSeq: 10 });
    expect(result).toMatchObject({ nextSeq: 17, wakeReason: "events", status: "running" });
    // Return on available events; the incomplete next frame is replayed on resume.
    expect(result.events.map((e) => e.seq)).toEqual([17]);
    expect(McpRunWaitResult.safeParse(result).success).toBe(true);
    expect(controlApiFetch).toHaveBeenCalledWith(
      expect.anything(),
      "/runs/run%2F1/events",
      expect.objectContaining({ headers: expect.objectContaining({ "Last-Event-ID": "10" }) }),
    );
    expect(cancelled).toHaveBeenCalledOnce();
    expect(controlApiFetch).toHaveBeenCalledTimes(3);
  });

  it("returns current pending interactions immediately despite a newer cursor", async () => {
    fixture([], snapshot("running", 12, [interaction]));
    const result = await runWaitQuery({ runId: "run-1", afterSeq: 100 });
    expect(result).toMatchObject({
      wakeReason: "interactions",
      nextSeq: 100,
      pendingInteractionCount: 1,
      pendingInteractions: [expect.objectContaining({ interactionId: "question-1" })],
    });
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["succeeded", "failed", "cancelled", "interrupted"])(
    "returns %s without requiring a terminal event",
    async (state) => {
      fixture([], snapshot(state));
      expect(await runWaitQuery({ runId: "run-1", afterSeq: 10 })).toMatchObject({
        wakeReason: "terminal",
        status: state,
        nextSeq: 10,
        events: [],
      });
      expect(controlApiFetch).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds event count and resumes at the last returned durable id", async () => {
    const { cancelled } = fixture([frame(11) + frame(15) + frame(19)]);
    const result = await runWaitQuery({ runId: "run-1", afterSeq: 10, maxEvents: 2 });
    expect(result).toMatchObject({ nextSeq: 15, eventOmission: "event_limit" });
    expect(result.events.map((e) => e.seq)).toEqual([11, 15]);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("bounds bytes and never advances across an unreturned oversized event", async () => {
    fixture([frame(11) + frame(12, "x".repeat(70_000))]);
    const result = await runWaitQuery({ runId: "run-1", afterSeq: 10 });
    expect(result).toMatchObject({ nextSeq: 11, eventOmission: "byte_limit" });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(131_072);
  });

  it("discloses a first oversized frame with an unchanged cursor", async () => {
    fixture([frame(11, "x".repeat(200_000))]);
    expect(await runWaitQuery({ runId: "run-1", afterSeq: 10 })).toMatchObject({
      nextSeq: 10,
      events: [],
      eventOmission: "oversized_frame",
      wakeReason: "events",
    });
  });

  it("times out a quiet queued SSE read, closes it, and refreshes once", async () => {
    const { cancelled } = fixture([": connected\n\n"], snapshot("queued", 0));
    const result = await runWaitQuery({ runId: "run-1", waitMs: 10 });
    expect(result).toMatchObject({
      wakeReason: "timeout",
      status: "queued",
      nextSeq: 0,
      snapshotPhase: "after_wait",
    });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(controlApiFetch).toHaveBeenCalledTimes(3);
  });

  it("refreshes questions and lifecycle on an SSE wake", async () => {
    fixture([frame(11)], snapshot(), snapshot("running", 12, [interaction]));
    expect(await runWaitQuery({ runId: "run-1" })).toMatchObject({
      wakeReason: "interactions",
      pendingInteractionCount: 1,
    });
  });

  it("observes terminal state on an end frame even when its terminal event is behind the cursor", async () => {
    fixture(["event: end\ndata: {}\n\n"], snapshot(), snapshot("succeeded", 10));
    expect(await runWaitQuery({ runId: "run-1", afterSeq: 10 })).toMatchObject({
      wakeReason: "terminal",
      status: "succeeded",
      nextSeq: 10,
    });
  });

  it("reports a disconnect honestly without retries or worker control", async () => {
    fixture([": connected\n\n"], snapshot(), snapshot(), true);
    expect(await runWaitQuery({ runId: "run-1" })).toMatchObject({
      wakeReason: "disconnected",
      status: "running",
      nextSeq: 0,
    });
    expect(controlApiFetch).toHaveBeenCalledTimes(3);
  });

  it("honors host abort and closes the reader without cancelling the worker", async () => {
    const host = new AbortController();
    const { cancelled } = fixture([": connected\n\n"]);
    const pending = runWaitQuery({ runId: "run-1" }, false, host.signal);
    await vi.waitFor(() => expect(controlApiFetch).toHaveBeenCalledTimes(2));
    host.abort();
    expect(await pending).toMatchObject({ wakeReason: "aborted", snapshotPhase: "before_wait" });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(controlApiFetch).toHaveBeenCalledTimes(2);
  });

  it("zero wait is snapshot-only and leaves the event cursor untouched", async () => {
    fixture([]);
    expect(await runWaitQuery({ runId: "run-1", afterSeq: 3, waitMs: 0 })).toMatchObject({
      nextSeq: 3,
      snapshotSeq: 10,
      events: [],
      wakeReason: "timeout",
    });
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
  });

  it("discloses omitted interaction bodies and keeps their exact total", async () => {
    const large = { ...interaction, sourceTool: "x".repeat(40_000) };
    fixture([], snapshot("running", 20, [large, interaction]));
    const result = await runWaitQuery({ runId: "run-1" });
    expect(result).toMatchObject({
      wakeReason: "interactions",
      pendingInteractionCount: 2,
      omittedInteractions: 2,
      pendingInteractions: [],
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(131_072);
  });

  it("preserves returned events when the final snapshot fails and labels freshness", async () => {
    fixture([frame(11)]);
    vi.mocked(controlApiFetch)
      .mockImplementationOnce(async () => Response.json(snapshot()))
      .mockImplementationOnce(
        async () => new Response(frame(11), { headers: { "content-type": "text/event-stream" } }),
      )
      .mockImplementationOnce(async () => {
        throw new Error("lost");
      });
    expect(await runWaitQuery({ runId: "run-1" })).toMatchObject({
      nextSeq: 11,
      snapshotPhase: "before_wait",
      snapshotProblem: "snapshot_unavailable",
    });
  });

  it.each([
    {},
    { runId: " " },
    { runId: "r", afterSeq: -1 },
    { runId: "r", waitMs: 50001 },
    { runId: "r", maxEvents: 0 },
    { runId: "r", afterSeq: Number.MAX_SAFE_INTEGER + 1 },
    { runId: "r", waitMs: 1.2 },
    { runId: "r", extra: true },
  ])("rejects malformed input before connection: %j", async (input) => {
    await expect(runWaitQuery(input)).rejects.toBeDefined();
    expect(connectDaemonIfRunning).not.toHaveBeenCalled();
  });

  it("keeps the privileged belt closed before connection", async () => {
    await expect(runWaitQuery({ runId: "r" }, true)).rejects.toMatchObject({
      code: "delegation_forbidden",
    });
    expect(connectDaemonIfRunning).not.toHaveBeenCalled();
  });

  it("does not start a missing daemon", async () => {
    vi.mocked(connectDaemonIfRunning).mockResolvedValue(null);
    await expect(runWaitQuery({ runId: "r" })).rejects.toMatchObject({
      code: "daemon_unavailable",
    });
    expect(controlApiFetch).not.toHaveBeenCalled();
  });

  it("preserves a missing-run refusal", async () => {
    vi.mocked(controlApiFetch).mockResolvedValue(
      Response.json({ code: "not_found", message: "no such run" }, { status: 404 }),
    );
    await expect(runWaitQuery({ runId: "r" })).rejects.toMatchObject({ code: "not_found" });
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
  });

  it("replays unread events of an already terminal run", async () => {
    fixture([frame(7) + frame(10)], snapshot("succeeded", 10));
    expect(await runWaitQuery({ runId: "run-1", afterSeq: 5 })).toMatchObject({
      wakeReason: "terminal",
      nextSeq: 10,
      events: [{ seq: 7 }, { seq: 10 }],
    });
  });

  it("resumes a bounded prefix without skipping the unreturned tail", async () => {
    fixture([frame(7) + frame(10) + frame(20)]);
    const first = await runWaitQuery({ runId: "run-1", maxEvents: 1 });
    fixture([frame(10) + frame(20)]);
    const resumed = await runWaitQuery({ runId: "run-1", afterSeq: first.nextSeq });
    expect([...first.events, ...resumed.events].map((e) => e.seq)).toEqual([7, 10, 20]);
    expect(resumed.nextSeq).toBe(20);
  });

  it.each([
    "id: 11\ndata: nope\n\n",
    `id: 11\ndata: ${JSON.stringify(event(12))}\n\n`,
    `id: 9007199254740992\ndata: ${JSON.stringify(event(11))}\n\n`,
    "data: {}\n\n",
  ])("does not advance across a malformed frame: %s", async (bad) => {
    const { cancelled } = fixture([frame(7) + bad + frame(20)]);
    expect(await runWaitQuery({ runId: "run-1" })).toMatchObject({
      wakeReason: "events",
      nextSeq: 7,
      eventOmission: "invalid_event",
      events: [{ seq: 7 }],
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("counts UTF-8 bytes rather than characters", async () => {
    fixture([frame(7, "😀".repeat(17_000))]);
    expect(await runWaitQuery({ runId: "run-1" })).toMatchObject({
      nextSeq: 0,
      events: [],
      eventOmission: "byte_limit",
    });
  });

  it("does not invent an empty interaction list from malformed snapshots", async () => {
    vi.mocked(controlApiFetch).mockResolvedValue(
      Response.json({ summary: { state: "running" }, lastSeq: 0 }),
    );
    await expect(runWaitQuery({ runId: "run-1" })).rejects.toBeDefined();
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
  });

  it("handles a stream read error with a native error code as a disconnect", async () => {
    let snapshots = 0;
    vi.mocked(controlApiFetch).mockImplementation(async (_addr, path) => {
      if (!path.endsWith("/events")) return Response.json(snapshot("running", snapshots++));
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    expect(await runWaitQuery({ runId: "run-1" })).toMatchObject({
      wakeReason: "disconnected",
      nextSeq: 0,
    });
  });

  it("removes host listeners on every completed read", async () => {
    const signal = new AbortController().signal;
    const add = vi.spyOn(signal, "addEventListener");
    const remove = vi.spyOn(signal, "removeEventListener");
    fixture([frame(11)]);
    await runWaitQuery({ runId: "run-1" }, false, signal);
    expect(add.mock.calls.length).toBeGreaterThan(0);
    for (const [name, listener] of add.mock.calls) {
      expect(remove).toHaveBeenCalledWith(name, listener);
    }
  });

  it("dispatches the public observation with its host signal and never reaches cancel bridging", async () => {
    fixture([]);
    const signal = new AbortController().signal;
    expect(
      await mcpSurfaceRunner()({ mode: "__run_wait", runId: "run-1", waitMs: 0 }, { signal }),
    ).toMatchObject({ wakeReason: "timeout", status: "running" });
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
  });

  it("blocks raw wait mode on a lineage-bound runner", async () => {
    await expect(
      mcpSurfaceRunner({ delegationParentRunId: "parent" })({ mode: "__run_wait", runId: "run-1" }),
    ).rejects.toMatchObject({ code: "delegation_forbidden" });
    expect(connectDaemonIfRunning).not.toHaveBeenCalled();
  });

  it("rejects an already aborted host before discovery", async () => {
    const host = new AbortController();
    host.abort();
    await expect(runWaitQuery({ runId: "run-1" }, false, host.signal)).rejects.toBeDefined();
    expect(connectDaemonIfRunning).not.toHaveBeenCalled();
  });

  it("honors host abort while discovery is still pending", async () => {
    const host = new AbortController();
    vi.mocked(connectDaemonIfRunning).mockReturnValue(new Promise(() => {}));
    const pending = runWaitQuery({ runId: "run-1" }, false, host.signal);
    const rejected = expect(pending).rejects.toBeDefined();
    host.abort();
    await rejected;
    expect(controlApiFetch).not.toHaveBeenCalled();
  });

  it("bounds stalled discovery separately from SSE waiting", async () => {
    vi.useFakeTimers();
    vi.mocked(connectDaemonIfRunning).mockReturnValue(new Promise(() => {}));
    const pending = runWaitQuery({ runId: "run-1" });
    const rejected = expect(pending).rejects.toMatchObject({ code: "run_observation_timeout" });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(controlApiFetch).not.toHaveBeenCalled();
  });
});
