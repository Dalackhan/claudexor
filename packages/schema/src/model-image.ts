import { z } from "zod/v3";
import { Id, NonBlankString } from "./primitives.js";
import { ControlProblem } from "./problem.js";
import {
  ImageMime,
  ModelAccountChoice,
  ModelCostEvidence,
  ModelRoute,
  ModelUsage,
} from "./model-operation.js";

export const ImageInput = z
  .object({
    mime: ImageMime,
    sha256: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .describe("Digest of the decoded bytes."),
    dataBase64: z
      .string()
      .min(1)
      .describe(
        "The caller's exact bytes in standard base64; forwarded verbatim, never re-encoded.",
      ),
  })
  .strict()
  .describe("One caller-owned edit reference; decoded bytes must match mime and sha256.");
export type ImageInput = z.infer<typeof ImageInput>;

export const ImageCallOptions = z
  .object({
    size: NonBlankString.optional().describe('Vendor size token, e.g. "auto" or "1024x1024".'),
    quality: z.enum(["low", "medium", "high", "auto"]).optional(),
    background: z.enum(["transparent", "opaque", "auto"]).optional(),
    n: z
      .number()
      .int()
      .positive()
      .max(10)
      .optional()
      .describe(
        "Requested image count in ONE provider request. Omitted sends no n; the provider may return several items either way.",
      ),
  })
  .strict()
  .describe("Only explicit options are sent; this transport adds no defaults of its own.");
export type ImageCallOptions = z.infer<typeof ImageCallOptions>;

export const ImageCallRequest = z
  .object({
    source: Id,
    model: NonBlankString.describe("Explicit image model; never derived from a text model."),
    account: ModelAccountChoice,
    prompt: NonBlankString,
    images: z
      .array(ImageInput)
      .default([])
      .describe("Empty selects generation; one or more selects an edit of these references."),
    options: ImageCallOptions.default({}),
  })
  .strict()
  .describe(
    "One image generation or edit request, stored only in a model-purpose payload outside the command journal.",
  );
export type ImageCallRequest = z.infer<typeof ImageCallRequest>;

export const GeneratedImage = z
  .object({
    mime: ImageMime.describe("Sniffed from the decoded bytes."),
    sha256: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .describe("Digest of the decoded bytes."),
    sizeBytes: z.number().int().nonnegative(),
    dataBase64: z.string().min(1).describe("The provider's b64_json, exact."),
    generationId: z.string().nullable(),
  })
  .strict();
export type GeneratedImage = z.infer<typeof GeneratedImage>;

export const ImageCallResult = z
  .object({
    outcome: z.enum(["completed", "failed", "unknown"]),
    operation: z.enum(["generate", "edit"]),
    requestedModel: NonBlankString.describe(
      "The model the caller asked for. route.model contains only a provider-observed model, or null.",
    ),
    images: z
      .array(GeneratedImage)
      .describe(
        "Every usable returned item, in provider order; rejected items are diagnosed in problem.",
      ),
    route: ModelRoute,
    appliedOptions: ImageCallOptions.describe("As reported by the provider response."),
    usage: ModelUsage,
    cost: ModelCostEvidence,
    providerRequestId: z.string().nullable(),
    problem: ControlProblem.nullable(),
  })
  .strict()
  .describe(
    "One provider image outcome; base64 lives only in this private result resource, never in model text.",
  );
export type ImageCallResult = z.infer<typeof ImageCallResult>;
