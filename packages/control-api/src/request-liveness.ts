import type { IncomingMessage, ServerResponse } from "node:http";

/** A completed request body may be destroyed normally while its response is live. */
export function requestGone(req: IncomingMessage, res: ServerResponse): boolean {
  return req.aborted || res.destroyed || req.socket.destroyed || (req.destroyed && !req.complete);
}
