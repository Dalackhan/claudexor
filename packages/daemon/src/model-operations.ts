import type { ModelAdapter } from "@claudexor/core";
import {
  ControlModelOperationDetail,
  ControlProblem,
  ImageCallRequest,
  ModelCallRequest,
  ModelOperationParams,
  ModelOperationReceipt,
  ModelUsage,
  isTerminalLifecycle,
  isModelOperation,
  type CancelReasonCode,
  type CredentialProfile,
  type ModelOperationRequestKind,
  type ModelPayloadRef,
  type ModelResponseCustody,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { commandStoreForId, commandStores, type CommandAuthority } from "./command-authority.js";
import { findAcceptedCommand } from "./command-rpc.js";
import type { JobRecord, RunContext } from "./server.js";
import {
  emptyDispatch,
  operationError,
  readModelPayload,
  executeModelOperation,
  type Evidence,
} from "./model-operation-execution.js";

export const MODEL_OPERATION_ID = "model.operation.create";

/** Existing ResourceStore supplies these purpose-bound byte operations. */
export interface ModelPayloadStore {
  readModel(ref: ModelPayloadRef): Buffer;
  publishModel(bytes: Uint8Array): ModelPayloadRef;
  releaseModel(ref: ModelPayloadRef): void;
  listModelResources(): Array<ModelPayloadRef & { createdAt: string }>;
}

export interface ModelOperationDependencies {
  commands: CommandAuthority;
  resources: () => ModelPayloadStore;
  enqueue(envelope: {
    request: ModelOperationParams;
    operation: string;
    idempotencyKey: string;
    clientId: string;
    idempotencyRequest: unknown;
  }): Promise<{ id: string }>;
  cancel(id: string, reason?: CancelReasonCode): Promise<unknown>;
  resolve(
    request: ModelCallRequest,
    signal: AbortSignal,
  ): Promise<{
    adapter: ModelAdapter;
    profile: CredentialProfile;
  }>;
  /** Image selection: pin/pool admission only, no text catalog read. Absent
   * means this engine composition has no image sources. */
  resolveImage?(
    request: ImageCallRequest,
    signal: AbortSignal,
  ): Promise<{
    adapter: ModelAdapter;
    profile: CredentialProfile;
  }>;
  now?: () => Date;
  warn?: (message: string) => void;
}

/** A model command reuses daemon queue/cancel/command authority. This owns only
 * the generation's payload custody; it has no scheduler or conversation cache. */
export class ModelOperations {
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly startedAt: number;

  constructor(private readonly deps: ModelOperationDependencies) {
    this.startedAt = this.now().getTime();
  }

  async create(
    request: ModelPayloadRef,
    idempotencyKey: string,
    captureFailureEvidence?: boolean,
    captureEffortEvidence?: boolean,
    requestKind?: ModelOperationRequestKind,
  ): Promise<ControlModelOperationDetail> {
    if (this.closed) throw operationError("daemon_stopping", "Model operations are stopping", 503);
    if (requestKind !== undefined && (captureFailureEvidence || captureEffortEvidence)) {
      // Image results carry no SSE/effort evidence; refusing is honest, ignoring is not.
      throw operationError(
        "unsupported_parameter",
        "requestKind=image cannot be combined with captureFailureEvidence or captureEffortEvidence",
        400,
      );
    }
    // Omission and false retain the historical command and idempotency bytes.
    const capture = {
      ...(captureFailureEvidence === true ? { captureFailureEvidence: true as const } : {}),
      ...(captureEffortEvidence === true ? { captureEffortEvidence: true as const } : {}),
      ...(requestKind !== undefined ? { requestKind } : {}),
    };
    const envelope = {
      request: ModelOperationParams.parse({ kind: "model", request, ...capture }),
      operation: MODEL_OPERATION_ID,
      idempotencyKey,
      clientId: "control-api",
      // Uploaded copies of identical bytes are the same idempotent request.
      idempotencyRequest: {
        kind: "model",
        sha256: request.sha256,
        sizeBytes: request.sizeBytes,
        ...capture,
      },
    };
    const replay = findAcceptedCommand(this.deps.commands, envelope);
    let id = replay?.id;
    if (!id) {
      // Validate only a NEW request. A settled replay's input has been released.
      // model_request_invalid from this boundary proves no command was accepted:
      // the idempotency lookup above succeeded and validation precedes enqueue.
      if (requestKind === "image") this.readImageRequest(request);
      else this.readRequest(request);
      id = (await this.deps.enqueue(envelope)).id;
    }
    // Re-uploaded copies can lose either the early lookup or the enqueue race.
    // Release only the unused copy; another live command may still own it.
    const canonical = ModelOperationParams.parse(this.record(id).params).request;
    if (canonical.resourceId !== request.resourceId) this.releaseIfUnused(request);
    return this.inspect(id);
  }

  async execute(raw: unknown, ctx: RunContext): Promise<ModelOperationReceipt> {
    return executeModelOperation(ModelOperationParams.parse(raw), ctx, this.deps, (evidence) =>
      this.update(ctx.jobId, evidence),
    );
  }

  inspect(id: string): ControlModelOperationDetail {
    const record = this.record(id);
    const evidence = this.evidence(record);
    const response = this.responseAt(evidence.response, this.now().getTime());
    return ControlModelOperationDetail.parse({
      id,
      state: record.state,
      createdAt: record.createdAt,
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
      ...evidence,
      response,
    });
  }

  readResult(id: string): { bytes: Buffer; sha256: string } {
    const detail = this.inspect(id);
    if (!isTerminalLifecycle(detail.state) || detail.response.state === "absent") {
      throw operationError("model_result_not_ready", "The model operation has no ready result");
    }
    if (detail.response.state !== "ready") {
      throw operationError(
        "model_result_released",
        "The model result was acknowledged or expired",
        410,
      );
    }
    return {
      bytes: this.deps.resources().readModel(detail.response.ref),
      sha256: detail.response.ref.sha256,
    };
  }

  acknowledge(id: string, sha256: string): ControlModelOperationDetail {
    const record = this.record(id);
    if (!isTerminalLifecycle(record.state))
      throw operationError("model_result_not_ready", "The operation is still running");
    const evidence = this.evidence(record);
    if (evidence.response.state === "absent")
      throw operationError("model_result_not_ready", "The operation has no result");
    const expected = evidence.response.ref.sha256;
    if (sha256 !== expected)
      throw operationError(
        "model_result_digest_mismatch",
        "Acknowledgement must name the received result digest",
      );
    if (evidence.response.state === "acknowledged" || evidence.response.state === "expired")
      return this.inspect(id);
    const ref = evidence.response.ref;
    evidence.response = this.responseAt(evidence.response, this.now().getTime());
    if (evidence.response.state === "ready") {
      evidence.response = { state: "acknowledged", ref, releasedAt: this.now().toISOString() };
    }
    this.update(id, ModelOperationReceipt.parse({ lifecycle: record.state, ...evidence }));
    this.releaseIfUnused(ref);
    this.armExpiry();
    return this.inspect(id);
  }

  async cancel(id: string, reason?: CancelReasonCode): Promise<ControlModelOperationDetail> {
    const record = this.record(id);
    if (!isTerminalLifecycle(record.state)) await this.deps.cancel(id, reason);
    return this.inspect(id);
  }

  /** Called by the existing daemon terminal boundary, queued cancellations included. */
  onCommandTerminal(record: JobRecord): void {
    const params = ModelOperationParams.safeParse(record.params);
    if (!params.success || !isTerminalLifecycle(record.state)) return;
    try {
      this.releaseIfUnused(params.data.request);
      this.armExpiry();
    } catch (error) {
      this.deps.warn?.(
        `Model payload reconciliation remains pending: ${redactSecrets(String(error))}`,
      );
    }
  }

  /** Existing maintenance invokes this after journal recovery/admission. Live
   * command refs protect bytes; operational blobs cannot recreate a terminal. */
  reconcileResources(dryRun = false): { released: string[]; errors: string[] } {
    const report = { released: [] as string[], errors: [] as string[] };
    const now = this.now().getTime();
    const records = this.records();
    const terminalRefs = new Set<string>();
    for (const record of records) {
      if (!isTerminalLifecycle(record.state)) continue;
      const params = ModelOperationParams.safeParse(record.params);
      // A malformed raw command is refused by execution; it owns no valid
      // payload ref and cannot prevent unrelated resource reconciliation.
      if (!params.success) continue;
      terminalRefs.add(params.data.request.resourceId);
      const evidence = this.evidence(record);
      const response = this.responseAt(evidence.response, now);
      if (response.state !== "absent") terminalRefs.add(response.ref.resourceId);
      if (response.state === "expired" && evidence.response.state === "ready" && !dryRun) {
        this.update(
          record.id,
          ModelOperationReceipt.parse({ lifecycle: record.state, ...evidence, response }),
        );
      }
    }
    const liveRefs = this.retainedResources(now, records);
    for (const ref of this.deps.resources().listModelResources()) {
      if (liveRefs.has(ref.resourceId)) continue;
      // A newly finalized input may still be on its way to create. Unbound
      // resources from before this daemon's birth are crash residue.
      const boundTerminal = terminalRefs.has(ref.resourceId);
      if (!boundTerminal && Date.parse(ref.createdAt) >= this.startedAt) continue;
      report.released.push(ref.resourceId);
      if (!dryRun) {
        try {
          const { createdAt: _createdAt, ...payload } = ref;
          this.deps.resources().releaseModel(payload);
        } catch (error) {
          report.errors.push(redactSecrets(String(error)));
        }
      }
    }
    if (!dryRun) this.armExpiry();
    return report;
  }

  close(): void {
    this.closed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private readRequest(ref: ModelPayloadRef): ModelCallRequest {
    return readModelPayload(this.deps.resources(), ref, ModelCallRequest, "ModelCallRequest");
  }

  private readImageRequest(ref: ModelPayloadRef): ImageCallRequest {
    if (ref.sizeBytes > 144 * 1024 * 1024)
      throw operationError("image_request_too_large", "The image request exceeds 144 MiB", 413);
    return readModelPayload(this.deps.resources(), ref, ImageCallRequest, "ImageCallRequest");
  }

  private records(): JobRecord[] {
    return commandStores(this.deps.commands)
      .flatMap((store) => store.records())
      .filter((record) => isModelOperation(record.params));
  }

  private record(id: string): JobRecord {
    const record = commandStoreForId(this.deps.commands, id)?.get(id);
    if (!record || !ModelOperationParams.safeParse(record.params).success) {
      throw operationError("model_operation_not_found", "No such model operation", 404);
    }
    return record;
  }

  private evidence(record: JobRecord): Evidence {
    const result =
      record.result && typeof record.result === "object"
        ? (record.result as Partial<ModelOperationReceipt>)
        : {};
    const evidence: Evidence = {
      dispatch: result.dispatch ?? emptyDispatch(),
      response: result.response ?? { state: "absent" },
      usage: result.usage ?? ModelUsage.parse({}),
      cost: result.cost ?? null,
      problem: result.problem ?? null,
    };
    if (isTerminalLifecycle(record.state) && evidence.dispatch.state === "started") {
      evidence.dispatch = { ...evidence.dispatch, state: "unknown" };
    }
    if (!evidence.problem && record.error)
      evidence.problem = ControlProblem.parse({
        code: record.errorCode || "model_operation_interrupted",
        message: redactSecrets(record.error),
        retryable: false,
      });
    return evidence;
  }

  private update(id: string, evidence: Evidence | ModelOperationReceipt): void {
    const store = commandStoreForId(this.deps.commands, id);
    if (!store) throw operationError("model_operation_not_found", "No such model operation", 404);
    store.update(id, { result: evidence });
  }

  private responseAt(response: ModelResponseCustody, now: number): ModelResponseCustody {
    return response.state === "ready" && Date.parse(response.expiresAt) <= now
      ? { state: "expired", ref: response.ref, releasedAt: response.expiresAt }
      : response;
  }

  private retainedResources(now: number, records = this.records()): Set<string> {
    const refs = new Set<string>();
    for (const record of records) {
      if (!isTerminalLifecycle(record.state)) {
        const params = ModelOperationParams.safeParse(record.params);
        if (params.success) refs.add(params.data.request.resourceId);
      }
      const response = this.responseAt(this.evidence(record).response, now);
      if (response.state === "ready") refs.add(response.ref.resourceId);
    }
    return refs;
  }

  private releaseIfUnused(ref: ModelPayloadRef): void {
    if (this.retainedResources(this.now().getTime()).has(ref.resourceId)) return;
    try {
      this.deps.resources().releaseModel(ref);
    } catch (error) {
      this.deps.warn?.(`Model payload cleanup remains pending: ${redactSecrets(String(error))}`);
    }
  }

  private armExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.closed) return;
    const due = this.records()
      .map((record) => this.evidence(record).response)
      .filter(
        (response): response is Extract<ModelResponseCustody, { state: "ready" }> =>
          response.state === "ready",
      )
      .map((response) => Date.parse(response.expiresAt))
      .filter(Number.isFinite);
    if (!due.length) return;
    const next = due.reduce((earliest, value) => Math.min(earliest, value), Infinity);
    const delay = Math.max(1, Math.min(2_147_483_647, next - this.now().getTime()));
    this.expiryTimer = setTimeout(() => {
      try {
        this.reconcileResources();
      } catch (error) {
        this.deps.warn?.(`Model payload maintenance failed: ${redactSecrets(String(error))}`);
      }
    }, delay);
    this.expiryTimer.unref?.();
  }
}
