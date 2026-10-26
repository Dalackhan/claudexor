import { z } from "zod/v3";
import { ContentHash, Id, NonBlankString } from "./primitives.js";
import {
  ControlUploadCreateRequest,
  ControlUploadFinalizeRequest,
  ControlUploadStatus,
} from "./attachment.js";

const uploadKey = NonBlankString.max(256).describe(
  "Caller-owned key for this exact stage. Save key and body before calling; replay both after an unknown response.",
);

/** Thin attachment-only controls over the existing HTTP upload lifecycle. */
export const McpUploadCreateInput = z
  .object({
    request: ControlUploadCreateRequest.omit({ purpose: true }),
    idempotencyKey: uploadKey,
  })
  .strict();
export type McpUploadCreateInput = z.infer<typeof McpUploadCreateInput>;

export const McpUploadTargetInput = z.object({ uploadId: Id }).strict();
export type McpUploadTargetInput = z.infer<typeof McpUploadTargetInput>;

export const McpUploadImportLocalInput = McpUploadTargetInput.extend({
  path: NonBlankString.describe(
    "Explicit absolute regular file on the MCP-server host, never the remote client's filesystem.",
  ),
}).strict();
export type McpUploadImportLocalInput = z.infer<typeof McpUploadImportLocalInput>;

export const McpUploadFinalizeInput = McpUploadTargetInput.extend({
  request: ControlUploadFinalizeRequest,
  idempotencyKey: uploadKey,
}).strict();
export type McpUploadFinalizeInput = z.infer<typeof McpUploadFinalizeInput>;

export const McpUploadImportLocalResult = ControlUploadStatus.extend({
  expectedSha256: ContentHash.optional().describe(
    "Digest of the verified local bytes. Save it for finalize; absent while uploading or cancelled.",
  ),
}).strict();
export type McpUploadImportLocalResult = z.infer<typeof McpUploadImportLocalResult>;
