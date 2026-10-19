/** Transport metadata, kept outside the strict engine run request. */
export const idempotencyKeySchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "\\S",
  description:
    "Caller-owned key for this exact launch. Reuse the same key and arguments after an unknown response to recover the accepted run/job; a different request with the same key conflicts. Omit for an intentional new launch.",
};
