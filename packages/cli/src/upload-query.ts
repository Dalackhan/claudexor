import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import {
  ControlResource,
  ControlUploadStatus,
  McpUploadCreateInput,
  McpUploadFinalizeInput,
  McpUploadImportLocalInput,
  McpUploadImportLocalResult,
  McpUploadTargetInput,
} from "@claudexor/schema";
import { connectDaemonIfRunning } from "./daemon-run.js";
import { CliError, controlProblemError, usageError } from "./cli-error.js";
import { controlApiFetch, type ControlApiAddress } from "./live.js";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";
import { openDocumentSource, requireAbsoluteDocumentPath } from "./local-document-source.js";

function responseValue<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw controlProblemError(
      502,
      { code: "invalid_response", error: "daemon returned an invalid upload response" },
      "daemon returned an invalid upload response",
    );
  }
}

function importFailure(error: unknown, uploadId: string, expectedSha256?: string): CliError {
  const failure =
    error instanceof CliError
      ? error
      : new CliError("operational", error instanceof Error ? error.message : String(error), {
          code:
            typeof (error as { code?: unknown })?.code === "string"
              ? (error as { code: string }).code
              : "upload_import_uncertain",
          retryable: false,
        });
  Object.assign(failure, {
    context: { ...failure.context, uploadId, ...(expectedSha256 ? { expectedSha256 } : {}) },
  });
  return failure;
}

async function uploadJson(
  addr: ControlApiAddress,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await controlApiFetch(addr, path, init);
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok)
    throw controlProblemError(
      response.status,
      body,
      `upload request failed (HTTP ${response.status})`,
    );
  return body;
}

async function importLocal(
  addr: ControlApiAddress,
  input: McpUploadImportLocalInput,
  signal?: AbortSignal,
) {
  const path = `/uploads/${encodeURIComponent(input.uploadId)}`;
  const status = responseValue(ControlUploadStatus, await uploadJson(addr, path, { signal }));
  if (status.uploadId !== input.uploadId) {
    throw controlProblemError(
      502,
      { code: "invalid_response", error: "daemon returned another upload identity" },
      "daemon returned another upload identity",
    );
  }
  // A second call never races or overwrites an uploaded/in-flight part.
  if (status.state === "uploading" || status.state === "cancelled") return status;
  const source = await openDocumentSource(input.path, status.expectedBytes).catch(
    (error: unknown) => {
      throw importFailure(error, input.uploadId);
    },
  );
  let body: Readable | undefined;
  let sourceFailure: unknown;
  try {
    if (status.state === "uploaded") {
      // Recover a lost digest from the explicit source, without a second PUT.
      for await (const _chunk of source.chunks()) {
        signal?.throwIfAborted();
      }
      return McpUploadImportLocalResult.parse({ ...status, expectedSha256: source.expectedSha256 });
    }
    body = Readable.from(
      (async function* () {
        try {
          yield* source.chunks();
        } catch (error) {
          sourceFailure = error;
          throw error;
        }
      })(),
    );
    // Observe source failures even when a peer rejects before reading the body.
    const settled = finished(body).catch((error: unknown) => error);
    const result = await uploadJson(addr, `${path}/bytes`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: Readable.toWeb(body) as unknown as RequestInit["body"],
      duplex: "half",
      signal,
    } as RequestInit & { duplex: "half" });
    if (!source.expectedSha256) {
      body.destroy();
      const error = await settled;
      throw error instanceof Error
        ? error
        : new Error("upload response arrived before the local source was verified");
    }
    const uploaded = responseValue(ControlUploadStatus, result);
    if (
      uploaded.uploadId !== input.uploadId ||
      uploaded.state !== "uploaded" ||
      uploaded.receivedBytes !== status.expectedBytes ||
      uploaded.expectedBytes !== status.expectedBytes
    ) {
      throw controlProblemError(
        502,
        { code: "invalid_response", error: "daemon returned inconsistent upload status" },
        "daemon returned inconsistent upload status",
      );
    }
    return McpUploadImportLocalResult.parse({ ...uploaded, expectedSha256: source.expectedSha256 });
  } catch (error) {
    // Unknown outcomes stay caller-owned: no cancellation, retry or finalize.
    if (!(error instanceof CliError) && sourceFailure) error = sourceFailure;
    throw importFailure(error, input.uploadId, source.expectedSha256);
  } finally {
    if (body) {
      body.destroy();
      await finished(body).catch(() => undefined);
    }
    await source.close();
  }
}

/** One requested operation; no second state owner, journal or lifecycle retries. */
export async function uploadQuery(
  action: string,
  raw: Record<string, unknown>,
  beltContext = false,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (beltContext)
    throw Object.assign(new Error("the delegation belt cannot access upload controls"), {
      code: "delegation_forbidden",
      status: 403,
    });
  const input =
    action === "create"
      ? McpUploadCreateInput.parse(raw)
      : action === "finalize"
        ? McpUploadFinalizeInput.parse(raw)
        : action === "import_local"
          ? McpUploadImportLocalInput.parse(raw)
          : action === "status" || action === "cancel"
            ? McpUploadTargetInput.parse(raw)
            : undefined;
  if (!input) throw usageError("unknown upload action", { code: "invalid_argument" });
  if (action === "import_local")
    requireAbsoluteDocumentPath((input as McpUploadImportLocalInput).path);
  const connection = await connectDaemonIfRunning();
  if (!connection) throw daemonUnavailableError(false, "upload controls do not start one");
  const { addr } = connection;
  if (action === "import_local")
    return importLocal(addr, input as McpUploadImportLocalInput, signal);
  const path = "uploadId" in input ? `/uploads/${encodeURIComponent(input.uploadId)}` : "/uploads";
  const mutation = action === "create" || action === "finalize";
  const result = await uploadJson(addr, `${path}${action === "finalize" ? "/finalize" : ""}`, {
    method: mutation ? "POST" : action === "cancel" ? "DELETE" : "GET",
    ...(mutation && "request" in input
      ? {
          headers: { "content-type": "application/json", "Idempotency-Key": input.idempotencyKey },
          body: JSON.stringify(input.request),
        }
      : {}),
    signal,
  });
  return action === "finalize"
    ? responseValue(ControlResource, result)
    : responseValue(ControlUploadStatus, result);
}
