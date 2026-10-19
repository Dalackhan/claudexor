import { McpRunWaitInput } from "@claudexor/schema";
import inputSchema from "@claudexor/schema/generated/McpRunWaitInput.schema.json" with { type: "json" };
import resultSchema from "@claudexor/schema/generated/McpRunWaitResult.schema.json" with { type: "json" };
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";
import { mcpToolFailure } from "./tool-failure.js";
import type { McpTool, RunnerFn } from "./index.js";

export function runWaitTool(runner: RunnerFn): McpTool {
  return {
    name: "claudexor_run_wait",
    description:
      "Observe an existing durable run through bounded SSE replay. Defaults: afterSeq=0, waitMs=25000, maxEvents=50. Zero wait reads a snapshot only. Resume with nextSeq; snapshotSeq never skips unread events. Events are capped at 64 KiB, pending interaction bodies at 32 KiB, structured result at 128 KiB (UTF-8 JSON); omissions are explicit. Daemon discovery and each snapshot read have separate 5s budgets. Timeout, disconnect and host abort close only this read, never the worker. Immediate interaction snapshots may leave events unread. Use run_result for output and run_interactions for omitted question bodies.",
    inputSchema: inlineJsonSchemaRefs(inputSchema),
    outputSchema: inlineJsonSchemaRefs(resultSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, ctx) => {
      try {
        const input = McpRunWaitInput.parse(args);
        const result = await runner({ mode: "__run_wait", ...input }, { signal: ctx.signal });
        return {
          text: JSON.stringify(result),
          structured: result as Record<string, unknown>,
        };
      } catch (error) {
        return mcpToolFailure(error);
      }
    },
  };
}
