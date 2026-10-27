import { z } from "zod/v3";
import { ControlHandshakeResponse } from "./operation.js";
import { ContentHash, Id, IsoTimestamp } from "./primitives.js";

const storeId = ControlHandshakeResponse.shape.storeId.unwrap();

export const AttachmentKind = z
  .enum(["image", "file"])
  .describe("Kind of attached resource: image input or generic file bytes.");
export type AttachmentKind = z.infer<typeof AttachmentKind>;

/** The only attachment authority accepted by run/turn requests. */
export const ResourceAttachmentRef = z
  .object({ resourceId: Id.describe("Immutable daemon resource id returned by upload finalize.") })
  .strict()
  .describe("Reference to an immutable daemon-owned uploaded resource.");
export type ResourceAttachmentRef = z.infer<typeof ResourceAttachmentRef>;

/** Internal resolved shape passed to adapters; never accepted from a client. */
export const Attachment = z
  .object({
    resource_id: Id.describe("Immutable daemon resource id."),
    kind: AttachmentKind,
    mime: z.string().min(1).describe("Declared MIME type validated against adapter limits."),
    name: z.string().describe("Original display name."),
    sha256: ContentHash.describe("Exact sha256 digest of the immutable bytes."),
    size_bytes: z.number().int().nonnegative().describe("Exact byte length."),
    path: z.string().describe("Daemon-owned immutable blob path; internal adapter input only."),
  })
  .strict()
  .describe("Daemon-resolved immutable resource supplied to a harness adapter.");
export type Attachment = z.infer<typeof Attachment>;

export const AttachmentTransport = z
  .enum(["file_path", "base64_stream", "base64_inline", "text_inline"])
  .describe("Native adapter transport used for one supported attachment class.");
export type AttachmentTransport = z.infer<typeof AttachmentTransport>;

/** Finite declaration: absent/unknown MIME is unsupported, never assumed. */
export const AttachmentInputClass = z
  .object({
    kind: AttachmentKind,
    mime_types: z.array(z.string().min(1)).min(1),
    max_bytes: z.number().int().positive().finite(),
    max_count: z.number().int().positive().finite(),
    transport: AttachmentTransport,
  })
  .strict()
  .describe("Finite MIME, size, count and transport limits declared by one adapter.");
export type AttachmentInputClass = z.infer<typeof AttachmentInputClass>;

export const ControlUploadCreateRequest = z
  .object({
    purpose: z
      .literal("model")
      .optional()
      .describe(
        "Model-operation payload (text or image); never an Agent attachment; absent preserves attachment semantics.",
      ),
    kind: AttachmentKind,
    mime: z.string().min(1),
    name: z.string().default(""),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type ControlUploadCreateRequest = z.infer<typeof ControlUploadCreateRequest>;

export const ControlUploadStatus = z
  .object({
    uploadId: Id,
    state: z.enum(["open", "uploading", "uploaded", "cancelled"]),
    receivedBytes: z.number().int().nonnegative(),
    expectedBytes: z.number().int().nonnegative(),
  })
  .strict();
export type ControlUploadStatus = z.infer<typeof ControlUploadStatus>;

export const ControlResource = z
  .object({
    resourceId: Id,
    purpose: z
      .literal("model")
      .optional()
      .describe("Immutable model-operation purpose; absent means a legacy or ordinary attachment."),
    kind: AttachmentKind,
    mime: z.string().min(1),
    name: z.string(),
    sha256: ContentHash,
    sizeBytes: z.number().int().nonnegative(),
    createdAt: IsoTimestamp,
    deduplicated: z.boolean(),
  })
  .strict();
export type ControlResource = z.infer<typeof ControlResource>;

export const ControlUploadFinalizeRequest = z
  .object({ expectedSha256: ContentHash.optional() })
  .strict();
export type ControlUploadFinalizeRequest = z.infer<typeof ControlUploadFinalizeRequest>;

export const ControlUploadImportContent = z
  .object({
    sizeBytes: z.number().int().nonnegative().describe("Exact byte length."),
    sha256: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .describe('Exact digest of the bytes: "sha256:" and 64 lowercase hex digits.'),
  })
  .strict()
  .describe("Exact bytes a keyed import owns, bound by its first accepted declaration.");
export type ControlUploadImportContent = z.infer<typeof ControlUploadImportContent>;

/** The key binds every field except the store check and `content`, which its first declaration binds. */
export const ControlUploadImportRequest = z
  .object({
    expectedStoreId: storeId.describe(
      "Store UUID from the opt-in handshake, saved with the key BEFORE the first import and replayed unchanged; never replaced by the current store. A different store is refused before any effect.",
    ),
    kind: AttachmentKind,
    mime: z.string().min(1),
    name: z.string().default(""),
    source: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        "Opaque caller identity of the selected source, such as the absolute path a local client read or a task artifact id. Bound into the key only; the daemon never reads, resolves, stores or returns it.",
      ),
    content: ControlUploadImportContent.optional().describe(
      "Required to begin an import. Omit it to read or replay an already bound key without touching the source.",
    ),
  })
  .strict()
  .describe("Keyed import of one ordinary attachment through the upload owner.");
export type ControlUploadImportRequest = z.infer<typeof ControlUploadImportRequest>;

export const ControlUploadImport = z
  .object({
    storeId: storeId.describe("Durable store that owns this import key and its resource."),
    state: z
      .enum(["open", "uploading", "ready", "cancelled"])
      .describe(
        "open: send the bound bytes; uploading: a transfer is in flight; ready: resource is published; cancelled: finished without a resource, a new attempt needs a new key.",
      ),
    uploadId: Id.describe("Upload that receives this import's bytes."),
    content: ControlUploadImportContent,
    receivedBytes: z.number().int().nonnegative(),
    resource: ControlResource.optional().describe(
      "The immutable resource, present exactly when state is ready.",
    ),
  })
  .strict()
  .refine((value) => (value.state === "ready") === (value.resource !== undefined), {
    message: "resource is present exactly when state is ready",
    path: ["resource"],
  })
  .describe("Current state of one keyed import, identical for its first call and every replay.");
export type ControlUploadImport = z.infer<typeof ControlUploadImport>;
