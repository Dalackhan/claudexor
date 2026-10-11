import { z } from "zod/v3";

/** Shared by quota evidence and account read/refresh requests without a schema cycle. */
export const QuotaRequestKind = z.enum(["text", "image"]);
export type QuotaRequestKind = z.infer<typeof QuotaRequestKind>;

/** Operation applicability is independent of any vendor model-id spelling. */
export function quotaConstraintAppliesToRequestKind(
  constraint: { applies_to_request_kinds?: QuotaRequestKind[] },
  requestKind: QuotaRequestKind = "text",
): boolean {
  return constraint.applies_to_request_kinds?.includes(requestKind) ?? true;
}
