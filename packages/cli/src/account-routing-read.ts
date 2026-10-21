import { ControlAccountRoutingEvidenceResponse } from "@claudexor/schema";

/** The additive routing-evidence read joined beside an Accounts listing. */
export type RoutingEvidenceRead = {
  routingEvidence?: ControlAccountRoutingEvidenceResponse;
  routingEvidenceProblem?: string;
};

/**
 * `GET /v2/accounts/routing-evidence` beside the primary listing, asking for the
 * capability marks. An engine that predates the read answers 404: nothing new
 * is shown; one that predates the capability query answers 400 and is read
 * again without it. Any other failure keeps the listing authoritative and adds
 * one diagnostic; it never fails the listing. `get` throws an error carrying
 * the HTTP `status`.
 */
export async function readRoutingEvidence(
  get: (path: string) => Promise<unknown>,
): Promise<RoutingEvidenceRead> {
  try {
    const body = await get("/accounts/routing-evidence?includeCapabilities=true").catch(
      (error: unknown) => {
        if ((error as { status?: unknown } | null)?.status !== 400) throw error;
        return get("/accounts/routing-evidence");
      },
    );
    const parsed = ControlAccountRoutingEvidenceResponse.safeParse(body);
    return parsed.success
      ? { routingEvidence: parsed.data }
      : {
          routingEvidenceProblem:
            "routing evidence unavailable: the response did not match its schema",
        };
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status === 404) return {};
    const reason = error instanceof Error ? error.message : String(error);
    return { routingEvidenceProblem: `routing evidence unavailable: ${reason}` };
  }
}

/** One account row's model-scoped evidence: live refusal/capability marks and its latest
 * service per requested model. Service is a routing observation, never a quota
 * or authentication verdict. */
export function routingEvidenceLines(
  read: RoutingEvidenceRead,
  harnessId: string,
  profileId: string,
  now = Date.now(),
): string[] {
  const evidence = read.routingEvidence;
  if (!evidence) return [];
  const model = (requested: string | null) => requested ?? "default model";
  const mine = <T extends { harness_id: string; profile_id: string }>(rows: readonly T[]) =>
    rows.filter((row) => row.harness_id === harnessId && row.profile_id === profileId);
  return [
    ...mine(evidence.capabilities ?? []).map(
      (mark) =>
        `model capability · ${mark.requested_model} · ${mark.state} · since ${mark.observed_at}, next probe ${mark.expires_at} · ${mark.provider_reason.length > 160 ? mark.provider_reason.slice(0, 159) + "…" : mark.provider_reason}`,
    ),
    ...mine(evidence.refusals)
      .filter((mark) => Date.parse(mark.expires_at) > now)
      .map(
        (mark) =>
          `recent refusal · ${model(mark.requested_model)} · observed ${mark.observed_at}, expires ${mark.expires_at}`,
      ),
    ...mine(evidence.lastService).map(
      (service) => `last served · ${model(service.requested_model)} · ${service.observed_at}`,
    ),
  ];
}
