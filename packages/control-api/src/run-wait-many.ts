import { setImmediate as yieldToAdmission } from "node:timers/promises";
import {
  RunWaitManyInput,
  RunWaitManyResult,
  isTerminalLifecycle,
  type RunWaitManySummary,
} from "@claudexor/schema";

export interface RunWaitManyHost {
  snapshot(ids: readonly string[], signal?: AbortSignal): Promise<RunWaitManySummary[]>;
  subscribe?(listener: (event: { run_id: string }) => void): () => void;
  pollMs?: number;
}

/** One observation, never a worker operation. Notifications invalidate the current
 * pass; they carry no attention facts or chronological cross-run ordering. */
export async function waitForRunAttention(
  input: unknown,
  host: RunWaitManyHost,
  signal?: AbortSignal,
): Promise<RunWaitManyResult> {
  // All callers, including future non-HTTP projections, share schema admission.
  const { targets, waitMs } = RunWaitManyInput.parse(input);
  const ids = targets.map((target) => target.runId);
  let summaries: RunWaitManySummary[] = targets.map(() => ({
    status: null,
    pending: null,
    token: null,
    problem: "not_observed",
  }));
  // The schema includes the final logical JSON byte assertion.
  const result = (wakeReason: RunWaitManyResult["wakeReason"], attention: number[] = []) =>
    RunWaitManyResult.parse({ wakeReason, attention, summaries });
  if (signal?.aborted) return result("aborted");

  const reads = new AbortController();
  let timedOut = false;
  let dirty = true;
  let closed = false;
  let notify: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const wake = () => {
    if (closed) return;
    dirty = true;
    notify?.();
  };
  const abort = () => {
    reads.abort();
    wake();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    // No alias filter: a queued job can bind to an unknown run ID. The compact
    // snapshot owns address resolution, and unrelated progress cannot be attention.
    unsubscribe = host.subscribe?.(wake);
    if (waitMs > 0) {
      deadline = setTimeout(() => {
        timedOut = true;
        abort();
      }, waitMs);
      // One timer only sets the dirty latch, even while a snapshot is pending.
      poll = setInterval(wake, host.pollMs ?? 250);
    }
    while (true) {
      if (signal?.aborted) return result("aborted");
      if (timedOut) return result("timeout");
      dirty = false;
      let rows: RunWaitManySummary[];
      try {
        // Await the active read itself on every exit. Abort/deadline signal its
        // cooperative work rather than racing and detaching an unresolved task.
        rows = await host.snapshot(ids, reads.signal);
      } catch (error) {
        if (signal?.aborted) return result("aborted");
        if (timedOut) return result("timeout");
        throw error;
      }
      if (rows.length !== targets.length)
        throw Object.assign(new Error("run observation returned an incomplete summary batch"), {
          code: "invalid_service_response",
          status: 500,
        });
      if (signal?.aborted) {
        // The source preserves completed positions and explicitly marks unread
        // ones not_observed; never replace them with inferred lifecycle facts.
        summaries = rows;
        return result("aborted");
      }
      // An interrupted deadline pass cannot replace the last completed pass.
      if (timedOut) return result("timeout");
      summaries = rows;
      const attention: number[] = [];
      let problems = false;
      for (let index = 0; index < summaries.length; index++) {
        if (index > 0 && index % 64 === 0) await yieldToAdmission();
        if (signal?.aborted) return result("aborted");
        if (timedOut) return result("timeout");
        const row = summaries[index]!;
        if (row.problem !== null) {
          problems = true;
          continue;
        }
        if ((row.pending || isTerminalLifecycle(row.status)) && targets[index]!.seen !== row.token)
          attention.push(index);
      }
      if (attention.length) return result("attention", attention);
      if (problems) return result("problems");
      if (waitMs === 0) return result("timeout");
      if (dirty) continue;
      await new Promise<void>((resolve) => {
        notify = resolve;
        // Recheck after installing the waiter: no notification may be lost
        // between the completed pass and the next sleep.
        if (dirty || reads.signal.aborted) resolve();
      });
      notify = undefined;
    }
  } finally {
    closed = true;
    clearTimeout(deadline);
    clearInterval(poll);
    signal?.removeEventListener("abort", abort);
    notify = undefined;
    reads.abort();
    unsubscribe?.();
  }
}
