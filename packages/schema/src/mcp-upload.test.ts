import { describe, expect, it } from "vitest";
import {
  McpUploadCreateInput,
  McpUploadFinalizeInput,
  McpUploadImportLocalInput,
} from "./mcp-upload.js";

describe("attachment ingress inputs", () => {
  const request = { kind: "file", mime: "text/plain", name: "note.txt", sizeBytes: 4 };
  it("requires caller-owned stage keys and rejects model purpose", () => {
    expect(McpUploadCreateInput.parse({ request, idempotencyKey: "create-key" }).request).toEqual(
      request,
    );
    for (const idempotencyKey of [undefined, "", " "]) {
      expect(McpUploadCreateInput.safeParse({ request, idempotencyKey }).success).toBe(false);
    }
    expect(
      McpUploadCreateInput.safeParse({
        request: { ...request, purpose: "model" },
        idempotencyKey: "k",
      }).success,
    ).toBe(false);
    expect(
      McpUploadFinalizeInput.parse({
        uploadId: "u",
        request: { expectedSha256: "sha256:abc" },
        idempotencyKey: "final-key",
      }),
    ).toMatchObject({ idempotencyKey: "final-key" });
    expect(McpUploadFinalizeInput.safeParse({ uploadId: "u", request: {} }).success).toBe(false);
  });
  it("requires an explicit host path and upload identity", () => {
    expect(McpUploadImportLocalInput.parse({ uploadId: "u", path: "/host/note.txt" })).toEqual({
      uploadId: "u",
      path: "/host/note.txt",
    });
    expect(McpUploadImportLocalInput.safeParse({ path: "/host/note.txt" }).success).toBe(false);
    expect(
      McpUploadImportLocalInput.safeParse({ uploadId: "u", path: "/host/note.txt", base64: "abc" })
        .success,
    ).toBe(false);
  });
});
