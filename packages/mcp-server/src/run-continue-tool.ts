import { mcpToolFailure } from "./tool-failure.js";
import { formatRunResult } from "./run-result-format.js";
import type { McpTool, RunnerFn } from "./index.js";

/** Continuation admission, history, workspace custody and inheritance belong to the daemon. */
export function runContinueTool(runner: RunnerFn): McpTool {
  return {
    name: "claudexor_run_continue",
    description:
      "Continue a terminal single-candidate Agent or Ask run on the existing daemon. Omitted settings inherit through the engine's continuation contract; prompt is optional and may be empty. Supply idempotencyKey to replay an unknown response. Returns a durable jobId or runId; pass either as runId to claudexor_run_status/claudexor_run_result for supervision.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: {
        runId: { type: "string", minLength: 1, pattern: "\\S" },
        prompt: { type: "string", description: "Optional continuation text; empty is valid." },
        idempotencyKey: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          pattern: "\\S",
          description: "Reuse the same key and arguments after an unknown response.",
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (args) => {
      try {
        const result = await runner({ ...args, mode: "__run_continue" });
        return {
          text: formatRunResult(result),
          structured: (result && typeof result === "object" ? result : {}) as Record<
            string,
            unknown
          >,
        };
      } catch (error) {
        return mcpToolFailure(error);
      }
    },
  };
}
