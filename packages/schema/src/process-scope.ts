import { z } from "zod/v3";

/**
 * The run's process-scope outcome: who the whole-run terminal barrier found
 * still carrying the run's scope marker, and what became of them. Written once
 * to `final/process_scope.yaml` as its OWN artifact so it survives the later
 * rewrites and projections the immutable RunFacts receipt goes through — a
 * finished run must always be able to say what it left running.
 *
 * It is a DISCLOSURE, never a verdict axis: a non-empty survivor set or a
 * Windows `tree_only` coverage never flips a succeeded run into a failure
 * (INV-116 is untouched). Environment bytes are never recorded — pid, measured
 * birth token and a short reason only.
 */
export const RunProcessScopeMember = z
  .object({
    pid: z.number().int().positive(),
    start_token: z
      .string()
      .min(1)
      .describe("Measured kernel birth token the member was ended under."),
  })
  .strict();
export type RunProcessScopeMember = z.infer<typeof RunProcessScopeMember>;

export const RunProcessScopeUnreadable = z
  .object({
    pid: z.number().int().positive(),
    reason: z.string().min(1).describe("Why a known member could not be read (never env bytes)."),
  })
  .strict();
export type RunProcessScopeUnreadable = z.infer<typeof RunProcessScopeUnreadable>;

export const RunProcessScopeOutcome = z
  .object({
    marker: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*_SCOPE_[0-9a-f]{32}$/)
      .describe("The run's scope marker NAME (the value is always 1; never persisted)."),
    coverage: z
      .enum(["marker", "tree_only"])
      .describe(
        "marker: an environment census ran (POSIX); tree_only: no environment census exists on this host (Windows), the parent-chain tree kill ran instead.",
      ),
    census: z
      .enum(["ok", "failed", "unsupported"])
      .describe(
        "ok: a census completed; failed: the process table could not be read; unsupported: no census on this platform.",
      ),
    census_failure: z.string().nullable().default(null),
    restricted: z
      .boolean()
      .default(false)
      .describe(
        "The platform withholds some processes' environments from the census (macOS SIP hides Apple platform-binary environments), so an empty census cannot exclude a hidden platform-binary leftover — a disclosed residual, never a failure.",
      ),
    ended: z
      .array(RunProcessScopeMember)
      .default([])
      .describe("Members found alive and proven gone."),
    survivors: z
      .array(RunProcessScopeMember)
      .default([])
      .describe("Members still alive under their recorded identity when the bounded ladder ended."),
    unreadable: z
      .array(RunProcessScopeUnreadable)
      .default([])
      .describe(
        "Known members whose identity or membership could not be read; never signalled unverified.",
      ),
    settled: z
      .boolean()
      .describe("True only when a census ran and nothing survived or stayed unreadable."),
  })
  .strict()
  .describe("What the whole-run terminal barrier found carrying the run's scope marker, and did.");
export type RunProcessScopeOutcome = z.infer<typeof RunProcessScopeOutcome>;
