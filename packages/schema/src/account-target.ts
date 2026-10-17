import { z } from "zod/v3";
import { QuotaRequestKind } from "./quota-request-kind.js";
export const AccountTarget = z
  .object({ harness: z.string().min(1), profile_id: z.string().min(1) })
  .strict();
export type AccountTarget = z.infer<typeof AccountTarget>;

export const ControlQuotaRefreshRequest = z
  .object({
    target: AccountTarget.optional(),
    requestKind: QuotaRequestKind.optional().describe(
      "Availability scope; omitted means text. Raw constraints retain every scope.",
    ),
    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional model id/alias the caller intends to spend against. When present, each snapshot's availability.state is computed against this model (case-insensitive alias containment in either direction), so windows scoped to OTHER models never report the subject exhausted.",
      ),
  })
  .strict()
  .describe(
    "Optional POST /v2/quota body; an empty or absent body keeps the model-agnostic projection.",
  );
export type ControlQuotaRefreshRequest = z.infer<typeof ControlQuotaRefreshRequest>;
