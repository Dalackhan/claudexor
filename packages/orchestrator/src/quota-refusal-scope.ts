import { ControlProblem, type QuotaRequestKind } from "@claudexor/schema";

/** Attach already-known request scope at the refusal producer. The context is
 * not recovered from its human message or generalized to the whole harness. */
export function quotaRefusalWithScope(
  error: Error,
  scope: {
    harness: string;
    profileId: string | null;
    model?: string | null;
    requestKind?: QuotaRequestKind;
    constraintId?: string | null;
  },
): Error {
  const typed = error as Error & {
    code?: string;
    resetsAt?: string | null;
    problem?: ControlProblem;
  };
  typed.problem = ControlProblem.parse({
    code: typed.code ?? "subscription_window_exhausted",
    message: error.message,
    retryable: false,
    context: {
      ...typed.problem?.context,
      resetsAt: typed.resetsAt ?? null,
      subject: { harness: scope.harness, profile_id: scope.profileId },
      model: scope.model ?? null,
      requestKind: scope.requestKind ?? "text",
      ...(scope.constraintId ? { constraint_id: scope.constraintId } : {}),
    },
  });
  return typed;
}
