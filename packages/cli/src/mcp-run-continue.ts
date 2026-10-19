import {
  ControlRunStartRequest,
  ControlRunStartResponse,
  validateOptionalNonEmptyString,
} from "@claudexor/schema";
import { connectDaemonIfRunning } from "./daemon-run.js";
import { controlProblemError } from "./cli-error.js";
import { controlApiFetch } from "./live.js";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";

// Project only the supported request fields: parsing the whole request here
// would materialize defaults before the daemon can inherit the predecessor.
const continuationRequest = ControlRunStartRequest.pick({ continueFrom: true, prompt: true })
  .partial({ prompt: true })
  .required({ continueFrom: true });

/** Submit once through the existing control transport; never register cwd or wait for terminal. */
export async function runContinueQuery(
  input: Record<string, unknown>,
  beltContext = false,
): Promise<Record<string, unknown>> {
  if (beltContext || input["delegatedFromRunId"] !== undefined) {
    throw Object.assign(new Error("the delegation belt cannot continue runs"), {
      code: "delegation_forbidden",
      status: 403,
    });
  }
  const body = continuationRequest.parse({
    continueFrom: input["runId"],
    ...(input["prompt"] !== undefined ? { prompt: input["prompt"] } : {}),
  });
  const key = input["idempotencyKey"];
  const keyError = validateOptionalNonEmptyString(key, "idempotencyKey");
  if (keyError || (typeof key === "string" && key.length > 256)) {
    throw Object.assign(new Error(keyError ?? "idempotencyKey must contain 1-256 characters"), {
      code: "invalid_argument",
      status: 400,
    });
  }
  const connection = await connectDaemonIfRunning();
  if (!connection) throw daemonUnavailableError(false, "run continuation does not start one");
  const response = await controlApiFetch(connection.addr, "/runs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(typeof key === "string" ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
  const result: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw controlProblemError(
      response.status,
      result,
      `run continuation failed (HTTP ${response.status})`,
    );
  }
  const parsed = ControlRunStartResponse.safeParse(result);
  if (!parsed.success) {
    throw controlProblemError(
      502,
      {
        code: "invalid_response",
        message: "daemon returned an invalid run continuation handle",
      },
      "daemon returned an invalid run continuation handle",
    );
  }
  const handle = parsed.data;
  const id = "runId" in handle ? handle.runId : handle.jobId;
  return {
    ...handle,
    summary: `Continuation accepted: ${id}. Use claudexor_run_status or claudexor_run_result with runId: ${id}.`,
  };
}
