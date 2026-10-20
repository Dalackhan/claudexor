import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { lastRunEventSeq } from "@claudexor/event-log";
import { directDelegatedChildrenFromRecords, type ControlRunSummary } from "@claudexor/schema";
import { measureSync } from "@claudexor/util";
import type { DaemonRunRecord } from "./run-record.js";

interface RunDetailContext {
  findRun(id: string): Promise<DaemonRunRecord | null>;
  children(parent: string): Promise<DaemonRunRecord[]>;
  summarize(record: DaemonRunRecord): ControlRunSummary;
  project(record: DaemonRunRecord, cursor: number, children: ControlRunSummary[]): unknown;
  json(res: ServerResponse, status: number, body: unknown): void;
}

export async function serveRunDetail(
  ctx: RunDetailContext,
  id: string,
  res: ServerResponse,
): Promise<void> {
  const rec = await ctx.findRun(id);
  if (!rec) return ctx.json(res, 404, { error: "no such run" });
  // Fence cursor FIRST, before pending interactions and every projection.
  const cursor = rec.runDir ? lastRunEventSeq(join(rec.runDir, "events.jsonl")) : 0;
  const parent = rec.runId ?? rec.id;
  // Reapply the addressed-child bound for engines predating this list query.
  const children = directDelegatedChildrenFromRecords(parent, await ctx.children(parent)).map(
    ctx.summarize,
  );
  ctx.json(
    res,
    200,
    measureSync("control.run_detail", () => ctx.project(rec, cursor, children)),
  );
}
