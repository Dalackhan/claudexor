import { ControlQueuedRunInfo, TaskGroupReceipt } from "@claudexor/schema";
import type { DaemonRunRecord } from "./run-record.js";

/** Membership comes only from the accepted request; embedders without store identity cannot mint it. */
export function acceptedTaskGroupReceipt(
  rec: DaemonRunRecord,
  storeId?: () => string | undefined,
): Partial<TaskGroupReceipt> {
  const params =
    rec.params && typeof rec.params === "object" ? (rec.params as Record<string, unknown>) : {};
  if (params["taskGroupId"] === undefined) return {};
  const receipt = TaskGroupReceipt.safeParse({
    taskGroupId: params["taskGroupId"],
    storeId: storeId?.(),
  });
  if (receipt.success) return receipt.data;
  throw Object.assign(new Error("accepted task group receipt needs the durable store identity"), {
    code: "store_identity_unavailable",
    status: 503,
    retryable: true,
    context: { jobId: rec.id, state: rec.state },
  });
}

export function unboundRunStartResponse(
  rec: DaemonRunRecord,
  terminal: boolean,
  terminalContext: Record<string, unknown> = {},
  metadata: Partial<TaskGroupReceipt> = {},
): { status: number; body: Record<string, unknown> } {
  // errorStatus is served verbatim only inside the failure range; anything
  // else (absent, or a non-4xx/5xx value from a defective writer) must not
  // turn a terminal failure body into a 2xx/3xx response.
  const errorStatus =
    typeof rec.errorStatus === "number" &&
    Number.isInteger(rec.errorStatus) &&
    rec.errorStatus >= 400 &&
    rec.errorStatus <= 599
      ? rec.errorStatus
      : 500;
  const queued = ControlQueuedRunInfo.parse({
    ...metadata,
    jobId: rec.id,
    state: rec.state,
    error: rec.error,
  });
  if (!terminal) return { status: 202, body: queued };
  const { taskGroupId: _group, storeId: _store, ...errorContext } = rec.errorContext ?? {};
  return {
    status: errorStatus,
    body: {
      ...queued,
      ...(rec.errorCode ? { code: rec.errorCode } : {}),
      // The daemon producer owns retryability when it supplied the fact. A
      // legacy typed refusal without the field keeps the prior conservative
      // non-retryable fallback; an untyped terminal makes no claim.
      ...(rec.errorRetryable !== undefined
        ? { retryable: rec.errorRetryable }
        : rec.errorCode
          ? { retryable: false }
          : {}),
      requiredActions: rec.errorRequiredActions ?? [],
      context: {
        ...errorContext,
        // Server-owned handles override any producer context with the same key.
        jobId: rec.id,
        state: rec.state,
        ...terminalContext,
        ...metadata,
      },
    },
  };
}
