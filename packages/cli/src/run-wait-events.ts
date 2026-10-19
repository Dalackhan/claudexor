import {
  MCP_RUN_WAIT_EVENT_BYTES,
  MCP_RUN_WAIT_RESULT_BYTES,
  RunEvent,
  type McpRunWaitInput,
  type McpRunWaitResult,
} from "@claudexor/schema";
import { CliError, controlProblemError } from "./cli-error.js";
import { controlApiFetch, type ControlApiAddress } from "./live.js";

type Observation = Pick<McpRunWaitResult, "events" | "nextSeq" | "eventOmission" | "wakeReason">;

/** One bounded subscription to the existing replay owner. No reconnect or status poll. */
export async function observeRunEvents(
  addr: ControlApiAddress,
  input: McpRunWaitInput,
  hostSignal?: AbortSignal,
): Promise<Observation> {
  const result: Observation = {
    events: [],
    nextSeq: input.afterSeq,
    eventOmission: null,
    wakeReason: "disconnected",
  };
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stop = () => {
    controller.abort();
    // Cancel releases a pending read even on transports which do not wire fetch's signal.
    void reader?.cancel().catch(() => {});
  };
  const onAbort = () => {
    result.wakeReason = "aborted";
    stop();
  };
  const timer = setTimeout(() => {
    result.wakeReason = "timeout";
    stop();
  }, input.waitMs);
  hostSignal?.addEventListener("abort", onAbort, { once: true });
  if (hostSignal?.aborted) onAbort();
  let eventBytes = 2; // JSON array delimiters
  let buffer = "";
  let data: string[] = [];
  let id = "";
  let name = "message";
  let frameBytes = 0;
  const omit = (reason: NonNullable<Observation["eventOmission"]>) => {
    result.eventOmission = reason;
    result.wakeReason = "events";
    return true;
  };
  const dispatch = (): boolean => {
    if (name === "end") return true;
    if (data.length === 0) return false;
    const seq = /^\d+$/.test(id) ? Number(id) : NaN;
    if (!Number.isSafeInteger(seq) || seq <= 0) return omit("invalid_event");
    let raw: unknown;
    try {
      raw = JSON.parse(data.join("\n"));
    } catch {
      return omit("invalid_event");
    }
    const parsed = RunEvent.safeParse(raw);
    if (!parsed.success || (parsed.data.seq !== undefined && parsed.data.seq !== seq))
      return omit("invalid_event");
    if (seq <= result.nextSeq) return false;
    const item = { seq, event: parsed.data };
    const bytes = Buffer.byteLength(JSON.stringify(item)) + (result.events.length ? 1 : 0);
    if (eventBytes + bytes > MCP_RUN_WAIT_EVENT_BYTES) return omit("byte_limit");
    result.events.push(item);
    result.nextSeq = seq;
    result.wakeReason = "events";
    eventBytes += bytes;
    return result.events.length >= input.maxEvents ? omit("event_limit") : false;
  };
  try {
    if (controller.signal.aborted) return result;
    const response = await controlApiFetch(
      addr,
      `/runs/${encodeURIComponent(input.runId)}/events`,
      {
        method: "GET",
        headers: { Accept: "text/event-stream", "Last-Event-ID": String(input.afterSeq) },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw controlProblemError(
        response.status,
        await response.json().catch(() => ({})),
        `run event stream failed (HTTP ${response.status})`,
      );
    }
    if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
      await response.body?.cancel();
      omit("invalid_event");
      return result;
    }
    reader = response.body.getReader();
    if (controller.signal.aborted) return result;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (;;) {
      const chunk = await reader.read();
      if (controller.signal.aborted || chunk.done) return result;
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        frameBytes += Buffer.byteLength(line) + 1;
        if (frameBytes > MCP_RUN_WAIT_RESULT_BYTES) {
          omit("oversized_frame");
          return result;
        }
        if (line === "") {
          if (dispatch()) return result;
          data = [];
          id = "";
          name = "message";
          frameBytes = 0;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "data") data.push(value);
          else if (field === "id") id = value;
          else if (field === "event") name = value;
        }
      }
      if (frameBytes + Buffer.byteLength(buffer) > MCP_RUN_WAIT_RESULT_BYTES) {
        omit("oversized_frame");
        return result;
      }
      // Drain the received chunk only: waiting for another event would add latency
      // to an observation which already has useful durable evidence.
      if (result.events.length) return result;
    }
  } catch (error) {
    if (controller.signal.aborted) return result;
    // A typed HTTP refusal must remain a refusal (not a successful empty read).
    if (error instanceof CliError) throw error;
    return { ...result, wakeReason: "disconnected" };
  } finally {
    clearTimeout(timer);
    hostSignal?.removeEventListener("abort", onAbort);
    controller.abort();
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
