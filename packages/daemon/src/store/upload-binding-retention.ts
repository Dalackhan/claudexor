import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ControlResource, ControlUploadStatus } from "@claudexor/schema";
import { StoreError } from "./errors.js";
import {
  bindIdempotencyInTx,
  deleteTargetIdempotencyInTx,
  lookupIdempotency,
  type IdempotencyBinding,
} from "./idempotency.js";
import { runMutation } from "./mutation.js";
import {
  putUploadInTx,
  readResourceRow,
  readUploadRow,
  type ResourceRow,
} from "./resource-rows.js";
import type { EngineStore } from "./store.js";

/** The accepted upload-binding lifetime starts at release/expiry, never at upload creation. */
export const UPLOAD_BINDING_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export type UploadOperation = "create" | "finalize" | "import";
export interface LegacyUploadBinding {
  operation: Exclude<UploadOperation, "import">;
  key: string;
  requestDigest: string;
  result: ControlUploadStatus | ControlResource;
}
export function uploadKeyDigest(operation: UploadOperation, key: string): string {
  return createHash("sha256").update(`${operation}\0${key}`).digest("hex");
}

/** Pure parser for the importer; serving lookup refuses a present invalid record. */
export function parseLegacyUploadBinding(
  raw: unknown,
  operation: LegacyUploadBinding["operation"],
  key: string,
): LegacyUploadBinding | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (value.operation !== operation || value.key !== key || typeof value.requestDigest !== "string")
    return undefined;
  const result =
    operation === "create"
      ? ControlUploadStatus.safeParse(value.result)
      : ControlResource.safeParse(value.result);
  if (!result.success) return undefined;
  return { operation, key, requestDigest: value.requestDigest, result: result.data };
}

/**
 * A present addressed record that cannot prove absence. Its message and problem
 * context carry the operation, key digest and root-relative file (CLI clients
 * keep only the message), never the raw key, record bytes, absolute path or
 * native error text. Retrying means resubmitting the same key after repair.
 */
function legacyBindingUnavailable(
  operation: UploadOperation,
  keyDigest: string,
  reason: "read_failed" | "invalid",
  cause?: unknown,
): StoreError {
  const file = `resource-store/idempotency/${keyDigest}.json`;
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  const errno =
    reason === "read_failed" && typeof code === "string" && /^E[A-Z0-9]+$/.test(code)
      ? code
      : undefined;
  const state =
    reason === "invalid" ? "is invalid" : `could not be read${errno ? ` (${errno})` : ""}`;
  return Object.assign(
    new StoreError(
      "legacy_upload_binding_unavailable",
      503,
      true,
      `historical upload ${operation} binding ${keyDigest} ${state}; restore ${file} under the daemon data root, then retry the same request with the same Idempotency-Key`,
      cause === undefined ? undefined : { cause },
    ),
    {
      requiredActions: [
        `Restore ${file} under the daemon data root (its original record and read access); deleting it does not repair the binding.`,
        "Retry the same request with the same Idempotency-Key.",
      ],
      context: { operation, keyDigest, reason, ...(errno ? { errno } : {}) },
    },
  );
}

function expired(row: ResourceRow | undefined, now: number): boolean {
  if (!row || (row.state !== "released" && row.state !== "expired")) return false;
  const releasedAt = row.releasedAt ?? (row.state === "expired" ? row.expiresAt : null);
  if (releasedAt === null) return false;
  const stamp = Date.parse(releasedAt);
  return Number.isFinite(stamp) && now - stamp >= UPLOAD_BINDING_RETENTION_MS;
}

/** SQL is authoritative once adopted. Historical files are point-read only on an enabled miss. */
export class UploadBindings {
  constructor(private readonly store: EngineStore) {}

  lookup(
    operation: UploadOperation,
    key: string,
    requestDigest: string,
    uploadId?: string,
  ): IdempotencyBinding | undefined {
    const address = {
      owner: "upload" as const,
      pid: 0,
      keyDigest: uploadKeyDigest(operation, key),
    };
    // Expired bindings are free even for a different request. Check their target before conflict.
    const target = this.store
      .prepare("SELECT target_id FROM idempotency WHERE owner='upload' AND pid=0 AND key_digest=?")
      .get(address.keyDigest) as { target_id: string } | undefined;
    if (target && this.targetExpired(target.target_id)) {
      runMutation(this.store, (tx) =>
        deleteTargetIdempotencyInTx(tx, "upload", 0, target.target_id),
      );
    }
    const saved = lookupIdempotency(this.store, address, requestDigest);
    // Keyed imports postdate the legacy file store; SQL is their only authority.
    if (saved || operation === "import") return saved;
    const enabled = this.store
      .prepare("SELECT value FROM meta WHERE key='legacy_idempotency_dir'")
      .get() as { value: string } | undefined;
    if (enabled?.value !== "present") return undefined;
    const legacy = this.readLegacy(operation, key, address.keyDigest);
    if (!legacy) return undefined;
    const targetId =
      operation === "create" ? (legacy.result as ControlUploadStatus).uploadId : uploadId!;
    const resource = operation === "finalize" ? (legacy.result as ControlResource) : undefined;
    // Metadata survives SQL cleanup, so a legacy JSON file cannot resurrect a retired binding.
    if (
      this.targetExpired(targetId) ||
      (resource &&
        expired(readResourceRow(this.store, resource.resourceId), this.store.now().getTime()))
    )
      return undefined;
    const binding: IdempotencyBinding = {
      ...address,
      operation,
      requestDigest: legacy.requestDigest,
      targetId,
      result: legacy.result,
      createdAt: this.store.now().toISOString(),
    };
    if (binding.requestDigest !== requestDigest)
      throw Object.assign(new Error("idempotency key was already used with a different request"), {
        code: "idempotency_conflict",
        status: 409,
      });
    runMutation(this.store, (tx) => {
      // Legacy finalize files have no upload id, but this exact request supplies it.
      // Keep a published target for lifetime accounting; never recreate resource bytes/metadata.
      if (resource && !readUploadRow(tx, targetId)) {
        putUploadInTx(tx, {
          request: {
            kind: resource.kind,
            mime: resource.mime,
            name: resource.name,
            sizeBytes: resource.sizeBytes,
            ...(resource.purpose ? { purpose: resource.purpose } : {}),
          },
          status: {
            uploadId: targetId,
            state: "uploaded",
            receivedBytes: resource.sizeBytes,
            expectedBytes: resource.sizeBytes,
          },
          state: "published",
          finalizeSha: null,
          resourceId: resource.resourceId,
        });
        tx.changes.uploadChanged(targetId);
      }
      bindIdempotencyInTx(tx, binding);
    });
    return binding;
  }

  /** Metadata rows remain so the point fallback applies this same lifetime forever. */
  prune(): number {
    const rows = this.store
      .prepare(
        `SELECT DISTINCT i.target_id FROM idempotency i
      JOIN upload u ON u.id=i.target_id
      JOIN resource r ON r.id=json_extract(CAST(u.body AS TEXT), '$.resourceId')
      WHERE i.owner='upload' AND i.pid=0 AND r.state IN ('released','expired')`,
      )
      .all() as Array<{ target_id: string }>;
    const targets = rows.filter((row) => this.targetExpired(row.target_id));
    if (!targets.length) return 0;
    return runMutation(this.store, (tx) =>
      targets.reduce(
        (n, row) => n + deleteTargetIdempotencyInTx(tx, "upload", 0, row.target_id),
        0,
      ),
    );
  }

  private targetExpired(id: string): boolean {
    const upload = readUploadRow(this.store, id);
    return (
      !!upload?.resourceId &&
      expired(readResourceRow(this.store, upload.resourceId), this.store.now().getTime())
    );
  }
  private readLegacy(
    operation: LegacyUploadBinding["operation"],
    key: string,
    digest: string,
  ): LegacyUploadBinding | undefined {
    let text: string;
    try {
      text = readFileSync(
        join(this.store.paths.resourceStore, "idempotency", `${digest}.json`),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw legacyBindingUnavailable(operation, digest, "read_failed", error);
    }
    let legacy: LegacyUploadBinding | undefined;
    try {
      legacy = parseLegacyUploadBinding(JSON.parse(text), operation, key);
    } catch (error) {
      throw legacyBindingUnavailable(operation, digest, "invalid", error);
    }
    if (!legacy) throw legacyBindingUnavailable(operation, digest, "invalid");
    return legacy;
  }
}
