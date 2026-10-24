import { RunWaitManyInput, RunWaitManyResult } from "@claudexor/schema";
import { CliError, controlProblemError } from "./cli-error.js";
import { controlApiFetch } from "./live.js";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";
import { connectForObservation } from "./mcp-run-wait.js";

const invalidResponse = () =>
  new CliError(
    "operational",
    "daemon returned an invalid compact run observation or mismatched target positions",
    { code: "invalid_service_response", retryable: true },
  );

/** One existing-daemon observer request; cancellation never controls a worker. */
export async function runsWaitQuery(
  rawInput: Record<string, unknown>,
  beltContext = false,
  signal?: AbortSignal,
): Promise<RunWaitManyResult> {
  if (beltContext)
    throw Object.assign(new Error("the delegation belt cannot wait on runs"), {
      code: "delegation_forbidden",
      status: 403,
    });
  // Preserve optional omission on the wire so defaults do not consume payload bytes.
  const input = RunWaitManyInput.parse(rawInput);
  signal?.throwIfAborted();
  const connection = await connectForObservation(signal);
  if (!connection) throw daemonUnavailableError(false, "run observation does not start one");
  signal?.throwIfAborted();

  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(
    () =>
      controller.abort(
        Object.assign(new Error("compact run observation HTTP read timed out"), {
          code: "run_observation_timeout",
          retryable: true,
        }),
      ),
    input.waitMs + 5_000,
  );
  try {
    const response = await controlApiFetch(connection.addr, "/runs/wait-many", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targets: input.targets,
        ...(rawInput["waitMs"] === undefined ? {} : { waitMs: input.waitMs }),
      }),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => {
      controller.signal.throwIfAborted();
      if (response.ok) throw invalidResponse();
      return null;
    });
    controller.signal.throwIfAborted();
    if (!response.ok)
      throw controlProblemError(
        response.status,
        body ?? {
          code: "run_observation_unavailable",
          message: "compact run observation is unavailable; use a daemon supporting wait-many",
          retryable: false,
        },
        `compact run observation failed (HTTP ${response.status})`,
      );
    const parsed = RunWaitManyResult.safeParse(body);
    if (!parsed.success || parsed.data.summaries.length !== input.targets.length)
      throw invalidResponse();
    return parsed.data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
