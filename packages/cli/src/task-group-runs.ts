import { ControlProblem, TaskGroupRunsInput, TaskGroupRunsResult } from "@claudexor/schema";
import { flagStr, requiredStringFlagError, type ParsedArgs } from "./args.js";
import { CliError, controlProblemError, renderCliFailure, usageError } from "./cli-error.js";
import { printJson } from "./cli-io.js";
import { controlApiFetch } from "./live.js";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";
import { connectForObservation } from "./mcp-run-wait.js";

const invalidResponse = () =>
  new CliError("operational", "daemon returned an invalid retained task group page", {
    code: "invalid_service_response",
    retryable: false,
  });

/** One supporting existing-daemon GET; never follows cursors or starts work. */
export async function taskGroupRunsQuery(
  rawInput: Record<string, unknown>,
  beltContext = false,
  signal?: AbortSignal,
): Promise<TaskGroupRunsResult> {
  if (beltContext)
    throw Object.assign(new Error("the delegation belt cannot recover task groups"), {
      code: "delegation_forbidden",
      status: 403,
    });
  const input = TaskGroupRunsInput.parse(rawInput);
  signal?.throwIfAborted();
  const connection = await connectForObservation(signal);
  if (!connection) throw daemonUnavailableError(false, "task group observation does not start one");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(
    () =>
      controller.abort(
        new CliError("operational", "task group HTTP read timed out", {
          code: "run_observation_timeout",
          retryable: true,
        }),
      ),
    5000,
  );
  const query = new URLSearchParams({ limit: String(input.limit) });
  for (const key of ["state", "cursor", "expectedStoreId"] as const) {
    const value = input[key];
    if (value !== undefined) query.set(key, value);
  }
  try {
    const response = await controlApiFetch(
      connection.addr,
      `/task-groups/${encodeURIComponent(input.taskGroupId)}/runs?${query}`,
      {
        method: "GET",
        signal: controller.signal,
      },
    );
    const body: unknown = await response.json().catch(() => {
      controller.signal.throwIfAborted();
      if (response.ok) throw invalidResponse();
      return null;
    });
    controller.signal.throwIfAborted();
    if (!response.ok) {
      const problem = ControlProblem.safeParse(body);
      throw controlProblemError(
        response.status,
        problem.success
          ? problem.data
          : {
              code: "task_group_runs_unavailable",
              message: "use a daemon supporting retained task group reads",
              retryable: false,
            },
        `task group read failed (HTTP ${response.status})`,
      );
    }
    const parsed = TaskGroupRunsResult.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.taskGroupId !== input.taskGroupId ||
      parsed.data.members.length > input.limit ||
      (input.expectedStoreId !== undefined && parsed.data.storeId !== input.expectedStoreId)
    )
      throw invalidResponse();
    return parsed.data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

export async function taskGroupRunsCommand(args: ParsedArgs, json: boolean): Promise<number> {
  try {
    const flags = ["limit", "state", "cursor", "expected-store-id"];
    const flagError = requiredStringFlagError(args, flags);
    if (flagError || args._.length !== 2)
      throw usageError(
        flagError ??
          "usage: claudexor task-group-runs <uuid> [--limit N] [--state S] [--cursor C] [--expected-store-id ID] --json",
        { code: "invalid_argument" },
      );
    const limit = flagStr(args, "limit");
    if (limit !== undefined && !/^[0-9]+$/.test(limit))
      throw usageError("--limit must be an integer from 1 to 200", { code: "invalid_argument" });
    const input: Record<string, unknown> = { taskGroupId: args._[1] };
    if (limit !== undefined) input["limit"] = Number(limit);
    for (const [flag, key] of [
      ["state", "state"],
      ["cursor", "cursor"],
      ["expected-store-id", "expectedStoreId"],
    ] as const) {
      const value = flagStr(args, flag);
      if (value !== undefined) input[key] = value;
    }
    printJson(await taskGroupRunsQuery(input));
    return 0;
  } catch (error) {
    return renderCliFailure(json, error, { messagePrefix: "claudexor task-group-runs:" });
  }
}
