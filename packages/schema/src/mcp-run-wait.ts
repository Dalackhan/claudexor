import { z } from "zod/v3";
import { ControlPendingInteraction, ControlRunState } from "./control.js";
import { RunEvent } from "./events.js";

export const MCP_RUN_WAIT_EVENT_BYTES = 65_536;
export const MCP_RUN_WAIT_INTERACTION_BYTES = 32_768;
export const MCP_RUN_WAIT_RESULT_BYTES = 131_072;

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const McpRunWaitInput = z
  .object({
    runId: z.string().trim().min(1).max(256),
    afterSeq: sequence.default(0).describe("Last returned durable SSE id, never snapshotSeq."),
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(50_000)
      .default(25_000)
      .describe(
        "Maximum SSE observation time; zero reads the current snapshot only. Daemon discovery and each snapshot read have separate 5s budgets.",
      ),
    maxEvents: z.number().int().min(1).max(200).default(50),
  })
  .strict();
export type McpRunWaitInput = z.infer<typeof McpRunWaitInput>;

export const McpRunWaitResult = z
  .object({
    runId: z.string(),
    status: ControlRunState,
    snapshotSeq: sequence.describe("Snapshot fence, separate from the returned event cursor."),
    snapshotPhase: z.enum(["before_wait", "after_wait"]),
    snapshotProblem: z
      .enum(["snapshot_unavailable"])
      .nullable()
      .describe(
        "A failed final read leaves the explicitly labelled initial snapshot, never invented current state.",
      ),
    nextSeq: sequence.describe("Last returned SSE id, or afterSeq when no event was returned."),
    events: z
      .array(z.object({ seq: sequence, event: RunEvent }).strict())
      .max(200)
      .describe(
        "Ordered new events, at most 65536 UTF-8 JSON bytes including envelopes. Legacy events retain their body and use the SSE id as seq.",
      ),
    eventOmission: z
      .enum(["event_limit", "byte_limit", "oversized_frame", "invalid_event"])
      .nullable()
      .describe(
        "A limit or invalid frame stopped observation; additional event count is unknown. Null means no such limit was reached, not that replay was exhausted. No cursor advances over unreturned events. An oversized first event requires another evidence surface.",
      ),
    pendingInteractions: z
      .array(ControlPendingInteraction)
      .describe(
        "Current snapshot's pending bodies, bounded to 32768 UTF-8 JSON bytes; use claudexor_run_interactions for omitted bodies.",
      ),
    pendingInteractionCount: sequence,
    omittedInteractions: sequence,
    wakeReason: z
      .enum(["events", "interactions", "terminal", "timeout", "aborted", "disconnected"])
      .describe(
        "Abort takes precedence; otherwise terminal, current interactions, events/omission, then timeout or disconnect. Disconnect is never completion. No worker is cancelled.",
      ),
  })
  .strict()
  .describe(
    "Read-only run observation, at most 131072 UTF-8 JSON bytes. At most two snapshot GETs and one SSE subscription; no automatic reconnect or worker cancellation. Resume with nextSeq. Snapshot-only/terminal/interaction wakes can leave events unread without changing the cursor.",
  );
export type McpRunWaitResult = z.infer<typeof McpRunWaitResult>;
