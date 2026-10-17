import { z } from "zod/v3";
import {
  ControlCredentialProfilesResponse,
  PreProgressRefusalObservation,
} from "./credential-profile.js";
import {
  ControlCredentialProfilesResourcesResponse,
  ControlCredentialProfilesSnapshotResponse,
} from "./credential-profile-snapshot.js";
import { Id, IsoTimestamp } from "./primitives.js";

/** The latest request an account served for one requested model (INV-135
 * tie-break evidence). A service observation, never a quota or auth verdict. */
export const AccountLastService = z
  .object({
    harness_id: Id.describe("Harness family of the account."),
    profile_id: Id.describe("Account row that served the request."),
    requested_model: z
      .string()
      .nullable()
      .describe("Model the run asked for; null = the harness default model."),
    observed_at: IsoTimestamp.describe("When the account was observed serving that request."),
  })
  .strict()
  .describe(
    "The latest observed service of one account for one requested model under its current credential binding.",
  );
export type AccountLastService = z.infer<typeof AccountLastService>;

/** `GET /v2/accounts/routing-evidence`: a separate additive read, so the legacy
 * strict Accounts responses stay unchanged for older clients. */
export const ControlAccountRoutingEvidenceResponse = z
  .object({
    refusals: z
      .array(PreProgressRefusalObservation)
      .describe("Live pre-progress refusal observations, each scoped to one requested model."),
    lastService: z
      .array(AccountLastService)
      .describe(
        "Latest observed service per registered account and requested model, most recent service first.",
      ),
  })
  .strict()
  .describe(
    "Model-scoped account routing evidence: live refusal marks and the durable last-served order.",
  );
export type ControlAccountRoutingEvidenceResponse = z.infer<
  typeof ControlAccountRoutingEvidenceResponse
>;

const routingEvidenceFields = {
  routingEvidence: ControlAccountRoutingEvidenceResponse.optional().describe(
    "Model-scoped routing evidence; absent when the engine predates the read or the read failed.",
  ),
  routingEvidenceProblem: z
    .string()
    .optional()
    .describe(
      "One diagnostic when the routing-evidence read failed; the account listing is still authoritative.",
    ),
};

/** `claudexor_accounts` output: the legacy listing (or opt-in snapshot) plus the
 * additive routing evidence. `accountPools.next_up` stays the configured
 * default model's verdict. */
export const McpAccountsToolResult = z
  .union([
    ControlCredentialProfilesResponse.extend(routingEvidenceFields),
    ControlCredentialProfilesSnapshotResponse.extend(routingEvidenceFields),
    ControlCredentialProfilesResourcesResponse.extend(routingEvidenceFields),
  ])
  .describe("Accounts listing or atomic snapshot joined with model-scoped routing evidence.");
export type McpAccountsToolResult = z.infer<typeof McpAccountsToolResult>;
