import type { IncomingMessage, ServerResponse } from "node:http";
import { RUN_WAIT_MANY_REQUEST_BYTES, RunWaitManyInput } from "@claudexor/schema";
import { requestGone } from "./request-liveness.js";
import { waitForRunAttention, type RunWaitManyHost } from "./run-wait-many.js";

interface RunWaitManyRouteContext {
  runObservations?: RunWaitManyHost["snapshot"];
  bus?: { subscribe: NonNullable<RunWaitManyHost["subscribe"]> };
  pollMs?: number;
  readBody(req: IncomingMessage, maxBytes?: number): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown, fallbackStatus?: 400 | 500): void;
}

/** Thin HTTP admission and response-liveness projection of the single observer. */
export async function handleRunWaitManyRoute(
  ctx: RunWaitManyRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!(method === "POST" && path === "/runs/wait-many")) return false;
  let input: unknown;
  try {
    input = await ctx.readBody(req, RUN_WAIT_MANY_REQUEST_BYTES);
    // Keep original ingress for observer admission without materialized defaults.
    RunWaitManyInput.parse(input);
  } catch (error) {
    if (!requestGone(req, res)) ctx.requestError(res, error);
    return true;
  }
  if (requestGone(req, res)) return true;
  const snapshot = ctx.runObservations;
  if (!snapshot) {
    ctx.requestError(
      res,
      Object.assign(new Error("compact run observation is unavailable"), {
        code: "run_observation_unavailable",
        status: 503,
        retryable: false,
      }),
      500,
    );
    return true;
  }

  const abort = new AbortController();
  const socket = req.socket;
  const disconnected = () => {
    // A consumed POST may emit close/destroyed while its response remains live.
    if (requestGone(req, res)) abort.abort();
  };
  req.on("aborted", disconnected);
  req.on("close", disconnected);
  res.on("close", disconnected);
  socket.on("close", disconnected);
  try {
    disconnected();
    const result = await waitForRunAttention(
      input,
      { snapshot, subscribe: ctx.bus?.subscribe.bind(ctx.bus), pollMs: ctx.pollMs },
      abort.signal,
    );
    if (!requestGone(req, res)) ctx.json(res, 200, result);
  } catch (error) {
    if (!requestGone(req, res)) ctx.requestError(res, error, 500);
  } finally {
    req.off("aborted", disconnected);
    req.off("close", disconnected);
    res.off("close", disconnected);
    socket.off("close", disconnected);
  }
  return true;
}
