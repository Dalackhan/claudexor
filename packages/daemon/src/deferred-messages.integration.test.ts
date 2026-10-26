import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@claudexor/schema", () => import("../../schema/src/index.js"));
vi.mock("@claudexor/daemon", () => import("./index.js"));
import {
  CapturedRunStart,
  ControlRunStartRequest,
  RunFacts,
  RunProcessScopeOutcome,
  SCHEMA_VERSION,
  makeOutcomeFacts,
  requiredActionsFor,
  needsOperatorAttention,
  type DeferredMessageReceipt,
} from "@claudexor/schema";
import { sqlFixture } from "./store/test-support/sql-fixture.js";
import { DaemonServer, type RunContext } from "./server.js";
import { DeferredMessages } from "./deferred-messages.js";
import { SqlCommandStore } from "./store/commands.js";
import { DaemonLocalClient } from "./daemon-local-client.js";
import { DaemonControlApiServer } from "../../control-api/src/daemon-server.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(
  mode: "ask" | "agent" = "ask",
  options: { custody?: boolean; failure?: boolean; outcome?: Record<string, unknown> } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-deferred-integration-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const sql = await sqlFixture(root);
  cleanups.push(() => sql.close());
  const done = barrier(),
    started: Array<{ params: any; ctx: RunContext }> = [];
  let predecessor = "";
  const capture = vi.fn(async (record, input) =>
    CapturedRunStart.parse({
      ...(record.params as object),
      ...input.controls,
      continueFrom: record.runId ?? record.id,
      prompt: input.prompt,
      attachments: input.attachments,
    }),
  );
  const validate = vi.fn(async () => {});
  const daemon = new DaemonServer({
    socketPath: join(root, "unused.sock"),
    token: "test",
    commands: sql.graph.commands,
    maxConcurrent: 2,
    deferredStart: () => ({ capture, validate }),
    runner: async (params, ctx) => {
      started.push({ params, ctx });
      const runDir = join(root, ctx.jobId);
      mkdirSync(join(runDir, "final"), { recursive: true });
      const runId = `run-${ctx.jobId}`,
        taskId = `task-${ctx.jobId}`;
      ctx.onRunStart({ runId, taskId, runDir });
      if (!predecessor) {
        predecessor = ctx.jobId;
        await Promise.race([
          done.promise,
          new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r(), { once: true })),
        ]);
      } else {
        await new Promise<void>((r) =>
          ctx.signal.addEventListener("abort", () => r(), { once: true }),
        );
        return { lifecycle: "cancelled" };
      }
      const lifecycle = options.failure ? "failed" : "succeeded";
      const facts = RunFacts.parse({
        schema_version: SCHEMA_VERSION,
        run_id: runId,
        task_id: taskId,
        mode,
        outcome: {
          ...makeOutcomeFacts(lifecycle),
          review_requested: false,
          work_state: { state: "completed", source: "constrained" },
          ...options.outcome,
        },
        deliverable: { present: true, kind: "answer", path: "final/answer.md" },
        presentation: { state: "ready", primary: { kind: "answer", path: "final/answer.md" } },
        participants: { planners: 0, attempts: [] },
        gates: {
          configured: false,
          required: 0,
          total: 0,
          executed: false,
          state: "not_configured",
        },
        review: { state: "not_run", blockers: 0, blocker_ids: [] },
        apply: { eligibility: null },
        required_actions: [],
        generated_at: new Date().toISOString(),
      });
      facts.required_actions = requiredActionsFor(
        facts.outcome,
        facts.apply.operator_decision_present,
      );
      if (options.custody !== false)
        writeFileSync(
          join(runDir, "final/process_scope.yaml"),
          JSON.stringify(
            RunProcessScopeOutcome.parse({
              marker: "CLAUDEXOR_SCOPE_0123456789abcdef0123456789abcdef",
              coverage: "marker+capture",
              census: "ok",
              settled: true,
              incomplete: false,
              survivors: [],
              unreadable: [],
              completeness: "not_provable",
            }),
          ),
        );
      const type =
        lifecycle !== "succeeded"
          ? "run.failed"
          : needsOperatorAttention(facts.outcome, false)
            ? "run.blocked"
            : "run.completed";
      sql.graph.commands.persistTerminal(
        ctx.jobId,
        {
          run_id: runId,
          task_id: taskId,
          seq: 1,
          ts: new Date().toISOString(),
          type,
          payload: {
            run_facts: facts,
            facts: facts.outcome,
            lifecycle,
            reason: facts.outcome.reason,
          },
        },
        null,
      );
      return sql.graph.commands.findById(ctx.jobId)!.get(ctx.jobId)!.result;
    },
  });
  cleanups.push(() => daemon.stop());
  const request = ControlRunStartRequest.parse({
    mode,
    prompt: "first",
    execution:
      mode === "agent"
        ? { isolation: "live", delegated: true, workspaceRoot: root }
        : { isolation: "envelope" },
  });
  const initial = (await daemon.dispatch("claudexor.enqueue", {
    request,
    clientId: "test",
    idempotencyKey: "predecessor",
  })) as { id: string };
  const input = {
    request: { action: "create", predecessorId: initial.id, prompt: "verify", attachments: [] },
    idempotencyKey: "draft",
  };
  const mutate = (raw: unknown) =>
    daemon.dispatch("claudexor.deferredMessage", raw) as Promise<DeferredMessageReceipt>;
  const create = () => mutate(input);
  const read = (id: string) => sql.graph.commands.deferredFor(id)!.get(id)!;
  return {
    root,
    sql,
    daemon,
    done,
    started,
    capture,
    validate,
    initial,
    input,
    mutate,
    create,
    read,
  };
}

describe("deferred promotion in the existing daemon queue", () => {
  it.each(["agent", "ask"] as const)(
    "releases %s custody before accepting and launching exactly one ordinary successor",
    async (mode) => {
      const f = await fixture(mode);
      const first = await f.create();
      expect(first.draft.state).toBe("waiting");
      expect(f.started).toHaveLength(1);
      expect(f.validate).not.toHaveBeenCalled();
      await expect(
        f.daemon.dispatch("claudexor.enqueue", {
          request: { ...f.started[0]!.params, continueFrom: f.initial.id },
          idempotencyKey: "overtake",
        }),
      ).rejects.toMatchObject({ code: "continuation_reserved" });
      f.done.release();
      await vi.waitFor(() => expect(f.read(first.draft.draftId).state).toBe("dispatched"));
      expect(f.started).toHaveLength(2);
      const successor = f.read(first.draft.draftId).successorJobId;
      expect(f.started[1]).toMatchObject({
        ctx: { jobId: successor },
        params: { prompt: "verify", continueFrom: `run-${f.initial.id}`, mode },
      });
      f.validate.mockRejectedValue(new Error("revoked"));
      expect(await f.create()).toMatchObject({
        appliedRevision: 1,
        draft: { state: "dispatched", successorJobId: successor },
      });
      expect(f.capture).toHaveBeenCalledTimes(1);
      expect(f.started).toHaveLength(2);
    },
  );
  it("stays waiting for native retry-shaped progress, then holds an actual failure", async () => {
    const f = await fixture("ask", { failure: true });
    const draft = (await f.create()).draft;
    sqlRetryEvent(f);
    expect(f.read(draft.draftId).state).toBe("waiting");
    f.done.release();
    await vi.waitFor(() => expect(f.read(draft.draftId).hold?.code).toBe("predecessor_failed"));
    expect(f.started).toHaveLength(1);
  });
  it.each([
    [{ custody: false }, "settlement_unknown"],
    [
      {
        outcome: {
          reason: "input_required",
          work_state: {
            state: "needs_input",
            source: "constrained",
            required_inputs: [{ kind: "decision", locator: null, description: "choose target" }],
          },
        },
      },
      "predecessor_needs_input",
    ],
    [{ outcome: { checks: "failed", reason: "checks_failed" } }, "predecessor_checks_failed"],
  ] as const)("holds incompatible evidence %j", async (options, code) => {
    const f = await fixture("ask", options);
    const draft = (await f.create()).draft;
    f.done.release();
    await vi.waitFor(() => {
      const record = f.sql.graph.commands.findById(f.initial.id)!.get(f.initial.id)!;
      expect(f.read(draft.draftId).hold?.code, JSON.stringify(record)).toBe(code);
    });
    expect(f.started).toHaveLength(1);
  });
  it("holds current admission refusal and never rearms on edit or readiness return", async () => {
    const f = await fixture();
    const draft = (await f.create()).draft;
    f.validate.mockRejectedValue(
      Object.assign(new Error("profile revoked"), { code: "profile_unavailable", status: 403 }),
    );
    f.done.release();
    await vi.waitFor(() => expect(f.read(draft.draftId).hold?.code).toBe("admission_refused"));
    f.validate.mockResolvedValue();
    expect(
      await f.mutate({
        request: {
          action: "replace",
          draftId: draft.draftId,
          expectedRevision: 1,
          prompt: "edited",
          attachments: [],
        },
        idempotencyKey: "edit",
      }),
    ).toMatchObject({ draft: { state: "held", revision: 2 } });
    expect(f.started).toHaveLength(1);
    expect(f.capture).toHaveBeenCalledTimes(1);
  });
  it.each(["replace", "clear", "stop", "shutdown"] as const)(
    "fences %s racing asynchronous dispatch preflight",
    async (action) => {
      const f = await fixture();
      const draft = (await f.create()).draft;
      const preflight = barrier();
      f.validate.mockImplementation(async () => preflight.promise);
      f.done.release();
      await vi.waitFor(() => expect(f.validate).toHaveBeenCalled());
      let edit: Promise<unknown> | undefined;
      if (action === "replace")
        edit = f.mutate({
          request: {
            action,
            draftId: draft.draftId,
            expectedRevision: 1,
            prompt: "latest",
            attachments: [],
          },
          idempotencyKey: action,
        });
      if (action === "clear")
        await f.mutate({
          request: { action, draftId: draft.draftId, expectedRevision: 1 },
          idempotencyKey: action,
        });
      if (action === "stop") await f.daemon.dispatch("claudexor.cancel", { id: f.initial.id });
      const stopping = action === "shutdown" ? f.daemon.stop() : undefined;
      preflight.release();
      await edit;
      await stopping;
      await vi.waitFor(() =>
        expect(f.read(draft.draftId).state).toBe(
          action === "replace" ? "dispatched" : action === "clear" ? "cleared" : "held",
        ),
      );
      expect(f.started).toHaveLength(action === "replace" ? 2 : 1);
      if (action === "replace") expect(f.started[1]!.params.prompt).toBe("latest");
    },
  );
  it("publishes the same committed receipt after an acceptance notification throws", async () => {
    const f = await fixture();
    const draft = (await f.create()).draft;
    const original = SqlCommandStore.prototype.acceptInTx;
    vi.spyOn(SqlCommandStore.prototype, "acceptInTx").mockImplementation(function (
      this: SqlCommandStore,
      tx,
      prepared,
    ) {
      const accepted = original.call(this, tx, prepared);
      tx.changes.afterCommit(() => {
        throw new Error("lost notification");
      });
      return accepted;
    });
    f.done.release();
    await vi.waitFor(() => expect(f.read(draft.draftId).state).toBe("dispatched"));
    expect(f.started).toHaveLength(2);
    expect((await f.create()).draft.successorJobId).toBe(f.started[1]!.ctx.jobId);
  });
  it("refuses raw Delegate/belt/child mutations and caller-owned snapshot injection before capture", async () => {
    const f = await fixture();
    for (const extra of [
      { beltContext: true },
      { delegatedFromRunId: "parent" },
      { operation: "delegated-run" },
    ])
      await expect(f.mutate({ ...f.input, ...extra })).rejects.toMatchObject({
        code: "delegation_forbidden",
        status: 403,
      });
    for (const method of ["claudexor.deferredMessageRead", "claudexor.deferredMessageProjection"])
      await expect(
        f.daemon.dispatch(method, {
          draftId: "unknown",
          predecessorId: f.initial.id,
          beltContext: true,
        }),
      ).rejects.toMatchObject({ code: "delegation_forbidden", status: 403 });
    const child = { ...f.started[0]!.params, delegatedFromRunId: "parent" };
    f.sql.graph.commands
      .forRequest(child)
      .accept({ id: "child", params: child, clientId: "fixture", idempotencyKey: "child" });
    await expect(
      f.mutate({ ...f.input, request: { ...f.input.request, predecessorId: "child" } }),
    ).rejects.toMatchObject({ code: "delegation_forbidden" });
    await expect(
      f.daemon.dispatch("claudexor.enqueue", {
        request: { ...f.started[0]!.params, deferredDefaults: {} },
        idempotencyKey: "injection",
      }),
    ).rejects.toMatchObject({ code: "server_owned_field" });
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.sql.store.prepare("SELECT count(*) n FROM deferred_message").get()).toEqual({ n: 0 });
  });
  it("rejects inline secret text before create and replace persistence", async () => {
    const f = await fixture();
    const prompt = "api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789";
    await expect(
      f.mutate({ ...f.input, request: { ...f.input.request, prompt } }),
    ).rejects.toThrow();
    expect(f.capture).not.toHaveBeenCalled();
    const draft = (await f.create()).draft;
    await expect(
      f.mutate({
        request: {
          action: "replace",
          draftId: draft.draftId,
          expectedRevision: 1,
          prompt,
          attachments: [],
        },
        idempotencyKey: "secret",
      }),
    ).rejects.toThrow();
    expect(f.read(draft.draftId).prompt).toBe("verify");
  });
  it("enforces the same operator boundary over real HTTP and projects addressed detail without bodies in collections", async () => {
    const f = await fixture();
    const control = new DaemonControlApiServer({
      token: "fixture",
      daemon: new DaemonLocalClient(() => f.daemon),
    });
    const { host, port } = await control.start();
    cleanups.push(() => control.stop());
    const http = async (path: string, body?: unknown, key = "http") => {
      const response = await fetch(`http://${host}:${port}/v2${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: "Bearer fixture",
          "x-claudexor-protocol-major": "3",
          "content-type": "application/json",
          "idempotency-key": key,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    for (const extra of [{ beltContext: true }, { delegatedFromRunId: "parent" }]) {
      const refused = await http("/runs/next-message", { ...f.input.request, ...extra });
      expect(refused).toMatchObject({ status: 403, body: { code: "delegation_forbidden" } });
    }
    const child = { ...f.started[0]!.params, delegatedFromRunId: "parent" };
    f.sql.graph.commands
      .forRequest(child)
      .accept({ id: "child", params: child, clientId: "fixture", idempotencyKey: "child" });
    expect(
      await http(
        "/runs/next-message",
        { ...f.input.request, predecessorId: "child" },
        "child-draft",
      ),
    ).toMatchObject({ status: 403, body: { code: "delegation_forbidden" } });
    expect(f.capture).not.toHaveBeenCalled();
    const accepted = await http("/runs/next-message", f.input.request);
    expect(accepted).toMatchObject({
      status: 200,
      body: { appliedRevision: 1, draft: { state: "waiting" } },
    });
    const id = accepted.body.draft.draftId;
    expect(
      await http("/runs", { continueFrom: f.initial.id, prompt: "overtake" }, "http-overtake"),
    ).toMatchObject({
      status: 409,
      body: { code: "continuation_reserved", context: { draftId: id } },
    });
    expect(await http(`/runs/next-message/${id}`)).toMatchObject({
      status: 200,
      body: { prompt: "verify", capturedStart: { continueFrom: `run-${f.initial.id}` } },
    });
    expect(await http(`/runs/${f.initial.id}`)).toMatchObject({
      status: 200,
      body: { deferredMessage: { draftId: id, state: "waiting" } },
    });
    const collection = await http("/runs");
    expect(collection.status).toBe(200);
    expect(JSON.stringify(collection.body)).not.toContain('"verify"');
    expect(JSON.stringify(collection.body)).not.toContain('"capturedStart"');
    f.capture.mockRejectedValue(new Error("capture revoked"));
    expect(await http("/runs/next-message", f.input.request)).toEqual(accepted);
    expect(f.capture).toHaveBeenCalledTimes(1);
  });
  it("recovers held startup state without read-triggered launch", async () => {
    const f = await fixture();
    const draft = (await f.create()).draft;
    f.sql.graph.commands.deferredFor(draft.draftId)!.recoverAfterStartup();
    f.done.release();
    await vi.waitFor(() =>
      expect(f.sql.graph.commands.queries.select({ ids: [f.initial.id] })[0]?.state).toBe(
        "succeeded",
      ),
    );
    const afterRestart = new DeferredMessages({
      commands: f.sql.graph.commands,
      preparation: () => ({ capture: f.capture, validate: f.validate }),
      active: () => false,
      stopped: () => false,
      publish: vi.fn(),
    });
    expect(afterRestart.read(draft.draftId)).toMatchObject({
      state: "held",
      hold: { code: "restart_requires_controller" },
    });
    await afterRestart.settled(f.initial.id);
    expect(f.started).toHaveLength(1);
  });
});

function sqlRetryEvent(f: Awaited<ReturnType<typeof fixture>>) {
  f.sql.graph.commands.recordRunEvent(f.started[0]!.params, {
    run_id: `run-${f.initial.id}`,
    task_id: `task-${f.initial.id}`,
    seq: 1,
    ts: new Date().toISOString(),
    type: "harness.event",
    payload: { type: "api_retry", status: 429, willRetry: true },
  });
}
