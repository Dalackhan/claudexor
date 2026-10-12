import { z } from "zod/v3";

/** The run's process-scope outcome, compact (counts, not pids) for the run summary. */
export const ControlProcessScope = z
  .object({
    settled: z
      .boolean()
      .describe("Every census source succeeded and nothing survived or stayed unreadable."),
    coverage: z.enum(["marker+capture", "marker", "tree_only"]),
    completeness: z
      .enum(["complete", "not_provable"])
      .describe(
        "Whether a settled reap proves the scope empty (not on macOS for background system binaries, not on Windows, not after a census failure, not when the single settlement deadline expired — then settled is false and the run's final/process_scope.yaml carries incomplete=true with completeness_reason naming the deadline).",
      ),
    census: z.enum(["ok", "failed", "unsupported"]),
    survivors: z
      .number()
      .int()
      .nonnegative()
      .describe("Members still alive when the bounded ladder ended."),
    unreadable: z
      .number()
      .int()
      .nonnegative()
      .describe("Known members whose identity or membership could not be read."),
  })
  .strict()
  .describe(
    "Compact process-scope outcome of a terminal run (full artifact: final/process_scope.yaml).",
  );
export type ControlProcessScope = z.infer<typeof ControlProcessScope>;

/**
 * `ControlRunSummary.processScope`: projected from the run's
 * final/process_scope.yaml; null while the run is live and for historical runs
 * without the artifact (absent = unknown, never clean).
 */
export const ControlRunSummaryProcessScope = ControlProcessScope.nullable()
  .default(null)
  .describe(
    "Compact process-scope outcome from final/process_scope.yaml (settled, coverage, completeness, survivors, unreadable, census); null while live or when unknown.",
  );
