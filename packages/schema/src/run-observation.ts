import { z } from "zod/v3";
import { ControlRunState } from "./control.js";
import { TaskGroupId } from "./task-group.js";

export const RUN_WAIT_MANY_MAX_TARGETS = 1000;
export const RUN_WAIT_MANY_REQUEST_BYTES = 1_048_576;
export const RUN_WAIT_MANY_RESULT_BYTES = 131_072;

const token = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/);
const handle = z.string().trim().min(1).max(256);

/** Internal scalar projection. Stored facts are validated per target, so one
 * malformed lifecycle cannot turn healthy sibling observations into failures. */
export const RunObservationRecord = z
  .object({
    jobId: z.string().min(1),
    runId: z.string().min(1).nullable(),
    partition: z.string().min(1),
    epoch: z.string().min(1),
    state: ControlRunState,
    createdAt: z.string().min(1),
    taskGroupId: TaskGroupId.optional(),
  })
  .strict();
export type RunObservationRecord = z.infer<typeof RunObservationRecord>;

export const RunWaitManyInput = z
  .preprocess(
    (value, ctx) => {
      // Measure the actual compact request before trimming IDs or adding defaults.
      // HTTP admission separately bounds incoming bytes before reading the body.
      try {
        const json = JSON.stringify(value);
        if (json !== undefined && Buffer.byteLength(json, "utf8") > RUN_WAIT_MANY_REQUEST_BYTES)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "wait-many request exceeds 1048576 bytes",
          });
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "wait-many request must be JSON serializable",
        });
      }
      return value;
    },
    z
      .object({
        targets: z
          .array(z.object({ runId: handle, seen: token.optional() }).strict())
          .min(1)
          .max(RUN_WAIT_MANY_MAX_TARGETS),
        waitMs: z.number().int().min(0).max(50_000).default(25_000),
      })
      .strict(),
  )
  .describe(
    "Read-only attention observation; compact request JSON is at most 1048576 UTF-8 bytes.",
  );
export type RunWaitManyInput = z.infer<typeof RunWaitManyInput>;

export const RunWaitManySummary = z.union([
  z.object({ status: ControlRunState, pending: z.boolean(), token, problem: z.null() }).strict(),
  z
    .object({
      status: z.null(),
      pending: z.null(),
      token: z.null(),
      problem: z.enum(["not_found", "snapshot_unavailable", "not_observed"]),
    })
    .strict(),
]);
export type RunWaitManySummary = z.infer<typeof RunWaitManySummary>;

export const RunWaitManyResult = z
  .object({
    wakeReason: z.enum(["attention", "problems", "timeout", "aborted"]),
    attention: z
      .array(
        z
          .number()
          .int()
          .min(0)
          .max(RUN_WAIT_MANY_MAX_TARGETS - 1),
      )
      .max(RUN_WAIT_MANY_MAX_TARGETS),
    summaries: z.array(RunWaitManySummary).min(1).max(RUN_WAIT_MANY_MAX_TARGETS),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.attention.some(
        (index, position) =>
          index >= value.summaries.length ||
          (position > 0 && index <= value.attention[position - 1]!),
      )
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attention"],
        message: "attention indexes must be ascending unique summary positions",
      });
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > RUN_WAIT_MANY_RESULT_BYTES)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "wait-many result exceeds 131072 bytes",
      });
  })
  .describe(
    "Lifecycle and pending attention only, at most 131072 UTF-8 JSON bytes; output readiness is a separate addressed read.",
  );
export type RunWaitManyResult = z.infer<typeof RunWaitManyResult>;
