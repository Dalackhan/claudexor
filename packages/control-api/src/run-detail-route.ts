import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { lastRunEventSeq } from "@claudexor/event-log";
import {
  directDelegatedChildrenFromRecords,
  type ControlRunSummary,
  type DeferredMessageProjection,
} from "@claudexor/schema";
import { measureSync } from "@claudexor/util";
import type { DaemonRunRecord } from "./run-record.js";
import { requestGone } from "./request-liveness.js";

interface RunDetailContext {
  findRun(id: string): Promise<DaemonRunRecord | null>;
  deferred?(id: string): Promise<DeferredMessageProjection | null>;
  children(parent: string): Promise<DaemonRunRecord[]>;
  summarize(record: DaemonRunRecord): ControlRunSummary;
  project(record: DaemonRunRecord, cursor: number, children: ControlRunSummary[]): unknown;
  json(res: ServerResponse, status: number, body: unknown): void;
}

export async function serveRunDetail(
  ctx: RunDetailContext,
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (requestGone(req, res)) return;
  const rec = await ctx.findRun(id);
  if (requestGone(req, res)) return;
  if (!rec) return ctx.json(res, 404, { error: "no such run" });
  // Fence cursor FIRST, before pending interactions and every projection.
  const cursor = rec.runDir ? lastRunEventSeq(join(rec.runDir, "events.jsonl")) : 0;
  const parent = rec.runId ?? rec.id;
  // Reapply the addressed-child bound for engines predating this list query.
  const records = await ctx.children(parent);
  if (requestGone(req, res)) return;
  const children = directDelegatedChildrenFromRecords(parent, records).map(ctx.summarize);
  const deferred = ctx.deferred ? { deferredMessage: await ctx.deferred(rec.id) } : {};
  ctx.json(
    res,
    200,
    measureSync("control.run_detail", () => ({
      ...(ctx.project(rec, cursor, children) as object),
      ...deferred,
    })),
  );
}
