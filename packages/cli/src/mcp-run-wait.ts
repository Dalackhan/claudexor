import {
  ControlRunDetail,
  isTerminalLifecycle,
  MCP_RUN_WAIT_INTERACTION_BYTES,
  MCP_RUN_WAIT_RESULT_BYTES,
  McpRunWaitInput,
  McpRunWaitResult,
} from "@claudexor/schema";
import { connectDaemonIfRunning } from "./daemon-run.js";
import { controlProblemError } from "./cli-error.js";
import { controlApiFetch, type ControlApiAddress } from "./live.js";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";
import { observeRunEvents } from "./run-wait-events.js";

// Consume only schema-owned snapshot fields, never interpret model/event prose.
const Snapshot = ControlRunDetail.pick({ lastSeq: true, pendingInteractions: true }).extend({
  summary: ControlRunDetail.shape.summary.pick({ state: true }),
  lastSeq: McpRunWaitResult.shape.snapshotSeq,
  pendingInteractions: ControlRunDetail.shape.pendingInteractions.removeDefault(),
});

/** The existing discovery API has no signal parameter; bound the caller's wait.
 * Its read-only handshake may still settle in the background after cancellation. */
async function connectForObservation(signal?: AbortSignal) {
  signal?.throwIfAborted();
  let onAbort = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal?.reason ?? new Error("run observation aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error("run observation daemon discovery timed out"), {
            code: "run_observation_timeout",
            retryable: true,
          }),
        ),
      5_000,
    );
  });
  try {
    return await Promise.race([connectDaemonIfRunning(), interrupted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function snapshot(addr: ControlApiAddress, runId: string, signal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 5_000);
  try {
    const response = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
      method: "GET",
      signal: controller.signal,
    });
    const body: unknown = await response.json();
    if (!response.ok)
      throw controlProblemError(
        response.status,
        body,
        `run snapshot failed (HTTP ${response.status})`,
      );
    return Snapshot.parse(body);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

/** Bounded read-only projection. Aborting observation never invokes makeCancelBridge. */
export async function runWaitQuery(
  rawInput: Record<string, unknown>,
  beltContext = false,
  signal?: AbortSignal,
): Promise<McpRunWaitResult> {
  if (beltContext)
    throw Object.assign(new Error("the delegation belt cannot wait on runs"), {
      code: "delegation_forbidden",
      status: 403,
    });
  const input = McpRunWaitInput.parse(rawInput);
  signal?.throwIfAborted();
  const connection = await connectForObservation(signal);
  if (!connection) throw daemonUnavailableError(false, "run observation does not start one");
  signal?.throwIfAborted();
  let latest = await snapshot(connection.addr, input.runId, signal);
  const result: McpRunWaitResult = {
    runId: input.runId,
    status: latest.summary.state,
    snapshotSeq: latest.lastSeq,
    snapshotPhase: "before_wait",
    snapshotProblem: null,
    nextSeq: input.afterSeq,
    events: [],
    eventOmission: null,
    pendingInteractions: [],
    pendingInteractionCount: 0,
    omittedInteractions: 0,
    wakeReason: "timeout",
  };
  const unreadTerminalEvents = latest.lastSeq > input.afterSeq;
  if (
    (!isTerminalLifecycle(latest.summary.state) || unreadTerminalEvents) &&
    !latest.pendingInteractions.length &&
    input.waitMs > 0
  ) {
    Object.assign(result, await observeRunEvents(connection.addr, input, signal));
    if (!signal?.aborted) {
      try {
        latest = await snapshot(connection.addr, input.runId, signal);
        result.snapshotPhase = "after_wait";
      } catch {
        result.snapshotProblem = "snapshot_unavailable";
      }
    }
  }
  result.status = latest.summary.state;
  result.snapshotSeq = latest.lastSeq;
  result.pendingInteractionCount = latest.pendingInteractions.length;
  let interactionBytes = 2;
  for (const pending of latest.pendingInteractions) {
    const bytes =
      Buffer.byteLength(JSON.stringify(pending)) + (result.pendingInteractions.length ? 1 : 0);
    if (interactionBytes + bytes > MCP_RUN_WAIT_INTERACTION_BYTES) break;
    interactionBytes += bytes;
    result.pendingInteractions.push(pending);
  }
  result.omittedInteractions = result.pendingInteractionCount - result.pendingInteractions.length;
  if (signal?.aborted) result.wakeReason = "aborted";
  else if (isTerminalLifecycle(result.status)) result.wakeReason = "terminal";
  else if (result.pendingInteractionCount) result.wakeReason = "interactions";
  // The event and interaction budgets leave room for all remaining scalar fields.
  if (Buffer.byteLength(JSON.stringify(result)) > MCP_RUN_WAIT_RESULT_BYTES)
    throw new Error("run observation exceeded its response byte budget");
  return result;
}
