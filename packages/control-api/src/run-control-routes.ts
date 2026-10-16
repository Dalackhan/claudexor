import type { IncomingMessage, ServerResponse } from "node:http";
import { ControlRunControlRequest, ControlRunControlResponse } from "@claudexor/schema";
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
  // A terminal run has no process to stop, so claiming "applied" would invent an effect.
  if (rec.state !== "queued" && rec.state !== "running") {
    appendRunAuditEvent(rec, "control.rejected", {
      control: body.control,
      reason: `run is terminal (${rec.state})`,
    });
    ctx.json(res, 409, { error: `run is ${rec.state}; ${body.control.kind} has nothing to stop` });
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
      message: `${body.control.kind} requested${activeDescendants.length ? ` for parent and ${activeDescendants.length} delegated descendant(s)` : ""}`,
    }),
  );
  return true;
}
