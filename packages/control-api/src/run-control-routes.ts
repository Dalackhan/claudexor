import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ControlRunControlRequest,
  ControlRunControlResponse,
  DeferredMessageStopReport,
} from "@claudexor/schema";
import { assertNoInlineSecretValues } from "@claudexor/util";
import { cancelDelegationFamily } from "./delegation-control.js";
import { appendRunAuditEvent } from "./run-audit.js";
import type { DaemonFacadeClient, DaemonRunRecord } from "./run-record.js";

export interface RunControlRouteContext {
  daemon: DaemonFacadeClient;
  pollMs?: number;
  findRun(id: string): Promise<DaemonRunRecord | null>;
  delegatedDescendants(parentRunId: string): Promise<DaemonRunRecord[]>;
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown): void;
}

export async function handleRunControlRoute(
  ctx: RunControlRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const controlMatch = /^\/runs\/([^/]+)\/control$/.exec(path);
  if (!(method === "POST" && controlMatch)) return false;
  const rec = await ctx.findRun(decodeURIComponent(controlMatch[1] as string));
  if (!rec) {
    ctx.json(res, 404, { error: "no such run" });
    return true;
  }
  let body: ControlRunControlRequest;
  try {
    const raw = await ctx.readBody(req);
    assertNoInlineSecretValues(raw);
    body = ControlRunControlRequest.parse(raw);
  } catch (err) {
    ctx.requestError(res, err);
    return true;
  }
  appendRunAuditEvent(rec, "control.requested", { control: body.control });
  const kind = body.control.kind;
  // Stop holds a next message that is not accepted yet, whatever the run's
  // lifecycle. A successor that was already accepted is named, never cancelled.
  let followUp: DeferredMessageStopReport = { held: false, draft: null };
  try {
    if (ctx.daemon.deferredMessageStop)
      followUp = DeferredMessageStopReport.parse(await ctx.daemon.deferredMessageStop(rec.id));
  } catch (error) {
    appendRunAuditEvent(rec, "control.rejected", {
      control: body.control,
      reason: error instanceof Error ? error.message : String(error),
    });
    ctx.requestError(res, error);
    return true;
  }
  const deferredMessage =
    followUp.draft && followUp.draft.state !== "cleared" ? followUp.draft : undefined;
  const successor =
    deferredMessage?.state === "dispatched"
      ? `its next message was already accepted as job ${deferredMessage.successorJobId}${deferredMessage.successorRunId ? ` (run ${deferredMessage.successorRunId})` : ""}, which this ${kind} does not stop`
      : null;
  // A terminal run has no process to stop, so claiming "applied" would invent an effect.
  if (rec.state !== "queued" && rec.state !== "running") {
    if (followUp.held) {
      appendRunAuditEvent(rec, "control.applied", { control: body.control });
      ctx.json(
        res,
        200,
        ControlRunControlResponse.parse({
          accepted: true,
          status: "applied",
          runId: rec.runId ?? rec.id,
          message: `run is ${rec.state}; ${kind} held its waiting next message`,
          deferredMessage,
        }),
      );
      return true;
    }
    appendRunAuditEvent(rec, "control.rejected", {
      control: body.control,
      reason: `run is terminal (${rec.state})${successor ? `; ${successor}` : ""}`,
    });
    ctx.json(
      res,
      409,
      successor
        ? {
            code: "next_message_dispatched",
            error: `run is ${rec.state}; ${kind} has nothing to stop: ${successor}`,
            requiredActions: [`Stop job ${deferredMessage!.successorJobId} to stop the successor.`],
            deferredMessage,
          }
        : {
            error: `run is ${rec.state}; ${kind} has nothing to stop`,
            ...(deferredMessage ? { deferredMessage } : {}),
          },
    );
    return true;
  }
  let activeDescendants: DaemonRunRecord[];
  try {
    const cancelled = await cancelDelegationFamily({
      daemon: ctx.daemon,
      parent: rec,
      descendantsAfterFence: () => ctx.delegatedDescendants(rec.runId ?? rec.id),
      pollMs: ctx.pollMs,
      // The typed class rides the abort into the terminal writers; the
      // free-text reason stays audit-only.
      reasonCode: body.control.reason_code,
    });
    activeDescendants = cancelled.descendants;
  } catch (error) {
    appendRunAuditEvent(rec, "control.rejected", {
      control: body.control,
      reason: error instanceof Error ? error.message : String(error),
    });
    ctx.requestError(res, error);
    return true;
  }
  appendRunAuditEvent(rec, "control.applied", { control: body.control });
  ctx.json(
    res,
    200,
    ControlRunControlResponse.parse({
      accepted: true,
      status: "applied",
      runId: rec.runId ?? rec.id,
      cascadeRunIds: activeDescendants.map((child) => child.runId ?? child.id),
      message: `${kind} requested${activeDescendants.length ? ` for parent and ${activeDescendants.length} delegated descendant(s)` : ""}${followUp.held ? "; its waiting next message is held" : ""}${successor ? `; ${successor}` : ""}`,
      ...(deferredMessage ? { deferredMessage } : {}),
    }),
  );
  return true;
}
