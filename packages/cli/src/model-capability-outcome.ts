import type {
  CapabilityAttempt,
  CapabilityBinding,
  ModelCapabilityLedger,
} from "@claudexor/daemon";
import type { PreProgressRefusalLedger } from "@claudexor/daemon";
import type { ModelCallRequest, ModelCallResult, ModelRoutingEvidence } from "@claudexor/schema";

/** Decorate one result, never invoke. The caller owns the next operation. */
export async function modelCapabilityOutcome(args: {
  request: ModelCallRequest;
  result: ModelCallResult;
  operationId: string;
  binding: CapabilityBinding;
  retry: CapabilityAttempt | null;
  ledger: ModelCapabilityLedger;
  refusals?: PreProgressRefusalLedger;
  routing: ModelRoutingEvidence;
  dispatched: boolean;
  hasAlternative: () => Promise<boolean>;
}): Promise<ModelCallResult> {
  const { request, result, binding, ledger, routing, retry } = args;
  const ownRoute =
    result.route.source === request.source &&
    result.route.credentialProfileId === binding.profileId &&
    result.route.accountFingerprint === binding.fingerprint;
  if (!ownRoute || !ledger.current(binding)) return { ...result, routing };
  const success =
    args.dispatched && result.outcome === "completed" && !result.problem && !result.modelMismatch;
  if (success) {
    ledger.served(binding);
    args.refusals?.clear(binding.harnessId, binding.profileId, request.model);
    if (retry) {
      ledger.settleRetry(request.retryOfOperationId!, "confirmed");
      routing.differentialOutcome = "confirmed";
    }
  }
  const problem = result.problem;
  const refusal =
    args.dispatched &&
    result.outcome === "failed" &&
    result.message === null &&
    problem?.code === "model_capability_refused" &&
    problem.context.generationStarted === false &&
    !(result.usage.output_tokens && result.usage.output_tokens > 0) &&
    !(result.usage.reasoning_tokens && result.usage.reasoning_tokens > 0);
  if (!refusal || !problem) {
    if (retry && !success) routing.differentialOutcome = "inconclusive";
    return { ...result, routing };
  }
  const current = {
    credentialProfileId: binding.profileId,
    accountFingerprint: binding.fingerprint,
    providerReason: String(problem.context.providerReason ?? problem.message),
    capabilityKind: problem.context.capabilityKind,
  };
  const accountsTried = retry
    ? [...(retry.problem.context.accountsTried as unknown[]), current]
    : [current];
  const equivalent =
    retry !== null && retry.problem.context.capabilityKind === problem.context.capabilityKind;
  // The correlated retry must repeat this history, and another account rejects
  // it before inference, so offering the retry would only spend the correlation.
  const blockedBy =
    !retry && request.account.mode === "auto" && historyBoundTo(request, binding)
      ? "native_continuation"
      : null;
  const decorated = {
    ...(equivalent ? retry!.problem : problem),
    retryable: false,
    context: {
      ...(equivalent ? retry!.problem.context : problem.context),
      source: request.source,
      operationId: args.operationId,
      requestedModel: request.model,
      credentialProfileId: equivalent ? retry!.binding.profileId : binding.profileId,
      accountFingerprint: equivalent ? retry!.binding.fingerprint : binding.fingerprint,
      accountMode: request.account.mode,
      retryOnOtherAccount: false,
      ...(blockedBy ? { retryBlockedBy: blockedBy } : {}),
      accountsTried,
      nextStep:
        request.account.mode === "pin"
          ? "Choose another account or a model supported by this pinned account."
          : blockedBy
            ? "The history carries native continuation bound to this account, so it cannot move to another account; resend without that continuation or start a new conversation."
            : "Check the requested model and account plan, refresh account catalogs, or choose another model.",
      ...(retry
        ? {
            retryOfOperationId: request.retryOfOperationId,
            differentialOutcome: equivalent ? "equivalent_refusal" : "inconclusive",
          }
        : {}),
    },
  };
  if (equivalent) {
    ledger.settleRetry(request.retryOfOperationId!, "equivalent_refusal");
    routing.differentialOutcome = "equivalent_refusal";
  } else if (request.account.mode === "auto") {
    ledger.refuse(binding, args.operationId, decorated, request);
    routing.differentialOutcome = retry ? "inconclusive" : "provisional";
    // A correlated retry cannot start another chain. Pinned requests never
    // acquire marks and never ask the host to switch an account.
    if (!retry && !blockedBy) {
      decorated.context.retryOnOtherAccount = await args.hasAlternative();
      if (decorated.context.retryOnOtherAccount)
        decorated.context.nextStep =
          "Re-send the same generation input once in auto mode with retryOfOperationId set to this operation id.";
    }
  }
  return { ...result, problem: decorated, routing };
}

/** Historical assistant continuation replays only on the account that produced it. */
function historyBoundTo(request: ModelCallRequest, binding: CapabilityBinding): boolean {
  return request.messages.some(({ nativeContinuation }) => {
    const route = nativeContinuation?.route;
    return (
      route !== undefined &&
      (route.credentialProfileId === binding.profileId ||
        (binding.fingerprint !== null && route.accountFingerprint === binding.fingerprint))
    );
  });
}
