import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import { codexAppServerInput } from "./attachments.js";
import { asObject, codexAppServerApprovalParams, type JsonObject } from "./app-server-protocol.js";
import { ownsNotification } from "./app-server-threads.js";

/** Start under the run's policy and bind the receipt to the root turn, not a child. */
export async function startCodexTurn(input: {
  spec: HarnessRunSpec;
  threadId: string;
  requiredMcpServers: string[];
  request(method: string, params: JsonObject): Promise<JsonObject>;
  nextNotification(
    method: string,
    accept: (params: JsonObject | null) => boolean,
    consume: boolean,
  ): Promise<JsonObject>;
}): Promise<HarnessEvent> {
  const { spec, threadId, request, nextNotification } = input;
  const turnResult = await request("turn/start", {
    threadId,
    ...codexAppServerApprovalParams(spec),
    input: codexAppServerInput(spec),
    ...(spec.output_schema != null ? { outputSchema: spec.output_schema } : {}),
  });
  const requestedTurnId = asObject(turnResult["turn"])?.["id"];
  const started = await nextNotification(
    "turn/started",
    (params) =>
      ownsNotification(params, threadId) &&
      (typeof requestedTurnId !== "string" ||
        asObject(params?.["turn"])?.["id"] === requestedTurnId),
    // Preserve arrival order so an earlier completion sees the new start queued.
    false,
  );
  const turnId =
    typeof requestedTurnId === "string"
      ? requestedTurnId
      : asObject(asObject(started["params"])?.["turn"])?.["id"];
  if (typeof turnId !== "string") throw new Error("Codex app-server omitted active turn id");
  return {
    type: "started",
    session_id: spec.session_id,
    ts: nowIso(),
    payload: {
      native_session_id: threadId,
      native_turn_id: turnId,
      ...(input.requiredMcpServers.length
        ? {
            mcp_servers: input.requiredMcpServers.map((name) => ({ name, status: "connected" })),
          }
        : {}),
    },
  };
}
