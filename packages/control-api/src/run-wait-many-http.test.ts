import { getEventListeners } from "node:events";
import { request, type ClientRequest, type IncomingHttpHeaders } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlOperationCatalog,
  ControlProblem,
  RunWaitManyResult,
  RUN_WAIT_MANY_REQUEST_BYTES,
  type ControlRunState,
  type RunObservationRecord,
} from "@claudexor/schema";
import { digestPendingIdentities } from "../../daemon/src/interactions.js";
import { readRunObservations } from "../../daemon/src/run-observation.js";
import { StoreBusyError } from "../../daemon/src/store/errors.js";
import { DaemonControlApiServer, type DaemonControlApiOptions } from "./daemon-server.js";

const fixtureCleanups: Array<() => Promise<void>> = [];
const clients = new Set<ClientRequest>();
const token = "wait-many-http-fixture";
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "X-Claudexor-Protocol-Major": "3",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A hang detector, not a performance promise. Also clears its own timer. */
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("HTTP fixture did not settle")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(async () => {
  for (const client of clients) client.destroy();
  clients.clear();
  try {
    for (const cleanup of fixtureCleanups.splice(0)) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

async function fixture(observationAvailable = true, pollMs = 1000) {
  const records = new Map<string, RunObservationRecord>();
  const questions = new Map<string, string[] | Error>();
  const listeners = new Set<(event: { run_id: string }) => void>();
  const firstRead = deferred<void>();
  const signals: AbortSignal[] = [];
  const forbidden = {
    enqueue: vi.fn(async () => {
      throw new Error("observer tried to enqueue");
    }),
    cancel: vi.fn(async () => {
      throw new Error("observer tried to cancel");
    }),
    runTimeLimit: vi.fn(async () => {
      throw new Error("observer changed a run deadline");
    }),
    answerInteraction: vi.fn(() => {
      throw new Error("observer tried to answer");
    }),
    sendRunMessage: vi.fn(async () => {
      throw new Error("observer tried to steer");
    }),
    createThreadTurn: vi.fn(async () => {
      throw new Error("observer tried to create a turn");
    }),
    applyThread: vi.fn(async () => {
      throw new Error("observer tried to apply");
    }),
    beginDelivery: vi.fn(async () => {
      throw new Error("observer tried to begin delivery");
    }),
    recordOperatorDecision: vi.fn(() => {
      throw new Error("observer tried to grant approval");
    }),
  };
  const list = vi.fn(async () => {
    throw new Error("wait-many used the old run-list projection");
  });
  const status = vi.fn(async () => {
    throw new Error("wait-many used the run-detail projection");
  });
  const read = (ids: readonly string[], signal?: AbortSignal) =>
    readRunObservations(
      {
        observationRecords: (requested) =>
          [...records.values()].filter(
            (row) =>
              requested.includes(row.jobId) ||
              (row.runId !== null && requested.includes(row.runId)),
          ),
      },
      {
        snapshotPendingIdentities: async (ids) =>
          new Map(
            ids.map((id) => {
              const value = questions.get(id) ?? [];
              return [id, value instanceof Error ? value : digestPendingIdentities(value)] as const;
            }),
          ),
      },
      "11111111-1111-4111-8111-111111111111",
      ids,
      signal,
    );
  const snapshot = vi.fn(async (ids: readonly string[], signal?: AbortSignal) => {
    if (signal) signals.push(signal);
    const rows = await read(ids, signal);
    firstRead.resolve();
    return rows;
  });
  const subscribe = vi.fn((listener: (event: { run_id: string }) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  const options: DaemonControlApiOptions = {
    token,
    pollMs,
    daemon: { list, status, ...forbidden },
    services: forbidden,
    bus: { subscribe },
    runObservations: observationAvailable ? snapshot : undefined,
  };
  const server = new DaemonControlApiServer(options);
  const { host, port } = await server.start();
  const base = `http://${host}:${port}`;
  function seed(
    jobId: string,
    state: ControlRunState = "running",
    runId: string | null = `run-${jobId}`,
  ) {
    records.set(jobId, {
      jobId,
      runId,
      state,
      partition: "global",
      epoch: "epoch-one",
      createdAt: "2026-10-22T00:00:00.000Z",
    });
  }
  function wake(runId: string) {
    for (const listener of listeners) listener({ run_id: runId });
  }
  function raw(
    body?: string | Buffer,
    path = "/v2/runs/wait-many",
    extraHeaders: Record<string, string> = {},
  ) {
    const client = request(`${base}${path}`, {
      method: "POST",
      headers: { ...headers, ...extraHeaders },
    });
    clients.add(client);
    client.on("close", () => clients.delete(client));
    const done = new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>(
      (resolve, reject) => {
        client.on("error", reject);
        client.on("close", () =>
          reject(new Error("HTTP client closed before response completion")),
        );
        client.on("response", (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () =>
            resolve({
              status: response.statusCode!,
              body: Buffer.concat(chunks).toString("utf8"),
              headers: response.headers,
            }),
          );
        });
      },
    );
    void done.catch(() => {});
    if (body !== undefined) client.end(body);
    return { client, done };
  }
  const f = {
    server,
    base,
    raw,
    seed,
    read,
    questions,
    wake,
    snapshot,
    firstRead,
    signals,
    subscribe,
    listeners,
    forbidden,
    list,
    status,
  };
  fixtureCleanups.push(async () => {
    await bounded(f.server.stop());
    expect(f.listeners.size).toBe(0);
    for (const forbidden of Object.values(f.forbidden)) expect(forbidden).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
    expect(f.status).not.toHaveBeenCalled();
  });
  return f;
}

async function write(client: ClientRequest, bytes: Buffer) {
  await bounded(
    new Promise<void>((resolve, reject) => {
      client.write(bytes, (error) => (error ? reject(error) : resolve()));
    }),
  );
}

function paddedBody(size: number) {
  const json = JSON.stringify({ targets: [{ runId: "a" }], waitMs: 0 });
  return Buffer.concat([Buffer.from(json), Buffer.alloc(size - Buffer.byteLength(json), 0x20)]);
}

describe("POST /v2/runs/wait-many over real HTTP", () => {
  it("keeps a completed POST alive, then wakes from the injected compact source without an idempotency key", async () => {
    const f = await fixture();
    f.seed("a");
    f.seed("b", "succeeded");
    const [knownB] = await f.read(["b"]);
    const pending = f.raw(
      JSON.stringify({
        targets: [{ runId: "a" }, { runId: "b", seen: knownB!.token! }, { runId: "run-a" }],
        waitMs: 1000,
      }),
    );
    await bounded(f.firstRead.promise);
    await nextTurn();
    expect(pending.client.writableFinished).toBe(true);
    expect(f.signals[0]).toBeDefined();
    expect(f.signals[0]!.aborted).toBe(false);
    expect(f.listeners.size).toBe(1);
    f.questions.set("run-a", ["question-a"]);
    f.wake("run-a");
    const response = await bounded(pending.done);
    expect(response.status).toBe(200);
    expect(RunWaitManyResult.parse(JSON.parse(response.body))).toEqual({
      wakeReason: "attention",
      attention: [0, 2],
      summaries: await f.read(["a", "b", "run-a"]),
    });
    expect(f.subscribe).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);
    expect(getEventListeners(f.signals[0]!, "abort")).toHaveLength(0);
  });

  it("advertises the schema-owned read-only naturally idempotent operation", async () => {
    const f = await fixture();
    const response = await fetch(`${f.base}/v2/operations`, { headers });
    expect(response.status).toBe(200);
    const catalog = ControlOperationCatalog.parse(await response.json());
    expect(
      catalog.operations.find(
        (operation) => operation.method === "POST" && operation.path === "/v2/runs/wait-many",
      ),
    ).toMatchObject({
      mutability: "read_only",
      idempotency: "natural",
      applicability: "run",
      requestSchema: "RunWaitManyInput",
      responseSchema: "RunWaitManyResult",
      errorSchema: "ControlProblem",
    });
  });

  it("returns a typed unavailable problem when the compact source is absent", async () => {
    const f = await fixture(false);
    const response = await bounded(
      f.raw(JSON.stringify({ targets: [{ runId: "a" }], waitMs: 0 })).done,
    );
    expect([501, 503]).toContain(response.status);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    const problem = ControlProblem.parse(JSON.parse(response.body));
    expect(problem.code).toMatch(/unavailable|unsupported/);
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.subscribe).not.toHaveBeenCalled();
  });

  it("preserves per-target failures and duplicate indexes beside healthy attention on the wire", async () => {
    const f = await fixture();
    f.seed("a", "succeeded");
    f.seed("broken");
    f.questions.set("run-broken", new Error("pending identities unavailable"));
    const ids = ["missing", "a", "broken", "run-a"];
    const response = await bounded(
      f.raw(
        JSON.stringify({
          targets: ids.map((runId) => ({ runId })),
          waitMs: 0,
        }),
      ).done,
    );
    expect(response.status).toBe(200);
    expect(RunWaitManyResult.parse(JSON.parse(response.body))).toEqual({
      wakeReason: "attention",
      attention: [1, 3],
      summaries: await f.read(ids),
    });
  });

  it.each([
    {},
    { targets: [] },
    { targets: [{ runId: " " }] },
    { targets: [{ runId: "a", seen: "not-a-token" }] },
    { targets: [{ runId: "a" }], waitMs: -1 },
    { targets: [{ runId: "a" }], waitMs: 50_001 },
    { targets: [{ runId: "a" }], progress: true },
    { targets: Array.from({ length: 1001 }, () => ({ runId: "a" })) },
  ])("refuses invalid input before discovery/subscription: %j", async (input) => {
    const f = await fixture();
    const response = await bounded(f.raw(JSON.stringify(input)).done);
    expect(response.status).toBe(400);
    ControlProblem.parse(JSON.parse(response.body));
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.subscribe).not.toHaveBeenCalled();
  });

  it("cleans an in-flight snapshot on an actual socket disconnect, with no worker control", async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const exited = deferred<void>();
    let active = 0;
    let readSignal: AbortSignal | undefined;
    f.snapshot.mockImplementationOnce(async (_ids, signal) => {
      readSignal = signal;
      active++;
      entered.resolve();
      try {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return [{ status: null, pending: null, token: null, problem: "not_observed" as const }];
      } finally {
        active--;
        exited.resolve();
      }
    });
    const pending = f.raw(JSON.stringify({ targets: [{ runId: "a" }], waitMs: 1000 }));
    await bounded(entered.promise);
    expect(active).toBe(1);
    pending.client.destroy();
    await bounded(exited.promise);
    await vi.waitFor(() => expect(f.listeners.size).toBe(0));
    expect(active).toBe(0);
    expect(readSignal?.aborted).toBe(true);
    expect(getEventListeners(readSignal!, "abort")).toHaveLength(0);
    const calls = f.snapshot.mock.calls.length;
    f.wake("run-a");
    await nextTurn();
    expect(f.snapshot).toHaveBeenCalledTimes(calls);
    await bounded(f.server.stop()); // A detached read/handler would keep stop pending.
  });

  it("bounds an in-flight snapshot by the observer deadline and settles its read before replying", async () => {
    const f = await fixture();
    let active = 0;
    let readSignal: AbortSignal | undefined;
    f.snapshot.mockImplementationOnce(async (_ids, signal) => {
      readSignal = signal;
      active++;
      try {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return [{ status: null, pending: null, token: null, problem: "not_observed" as const }];
      } finally {
        active--;
      }
    });
    const response = await bounded(
      f.raw(JSON.stringify({ targets: [{ runId: "a" }], waitMs: 30 })).done,
    );
    expect(response.status).toBe(200);
    expect(RunWaitManyResult.parse(JSON.parse(response.body))).toEqual({
      wakeReason: "timeout",
      attention: [],
      summaries: [{ status: null, pending: null, token: null, problem: "not_observed" }],
    });
    expect(active).toBe(0);
    expect(readSignal?.aborted).toBe(true);
    expect(f.listeners.size).toBe(0);
    expect(getEventListeners(readSignal!, "abort")).toHaveLength(0);
    await bounded(f.server.stop());
  });

  it.each([
    new StoreBusyError("fixture snapshot unavailable"),
    new Error("fixture snapshot failed"),
  ])(
    "projects a throwing snapshot as a request problem and releases the observer: %s",
    async (error) => {
      const f = await fixture();
      f.snapshot.mockRejectedValueOnce(error);
      const response = await bounded(
        f.raw(JSON.stringify({ targets: [{ runId: "a" }], waitMs: 1000 })).done,
      );
      expect(response.status).toBe(error instanceof StoreBusyError ? 503 : 500);
      const problem = ControlProblem.parse(JSON.parse(response.body));
      if (error instanceof StoreBusyError)
        expect(problem).toMatchObject({ code: "store_busy", retryable: true });
      expect(problem).not.toHaveProperty("summaries");
      expect(f.listeners.size).toBe(0);
      await bounded(f.server.stop());
    },
  );

  it("accepts exactly 1MiB raw input and rejects the next byte before discovery", async () => {
    const f = await fixture();
    f.seed("a", "succeeded");
    const admitted = await bounded(f.raw(paddedBody(RUN_WAIT_MANY_REQUEST_BYTES)).done);
    expect(admitted.status).toBe(200);
    expect(RunWaitManyResult.parse(JSON.parse(admitted.body)).attention).toEqual([0]);
    f.snapshot.mockClear();
    f.subscribe.mockClear();
    const refused = await bounded(f.raw(paddedBody(RUN_WAIT_MANY_REQUEST_BYTES + 1)).done);
    expect(refused.status).toBe(413);
    ControlProblem.parse(JSON.parse(refused.body));
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.subscribe).not.toHaveBeenCalled();
  });

  it("admits exactly 1MiB with omitted waitMs through route and observer revalidation", async () => {
    let controls = 155_910;
    const targets = Array.from({ length: 1000 }, () => {
      const count = Math.min(256, controls);
      controls -= count;
      return { runId: "\u0001".repeat(count) + "x".repeat(256 - count) };
    });
    targets[999]!.runId = "€" + "é".repeat(11) + "x".repeat(244);
    const input = { targets };
    const bytes = JSON.stringify(input);
    expect(Buffer.byteLength(bytes, "utf8")).toBe(1_048_576);
    expect(input).not.toHaveProperty("waitMs");
    const f = await fixture();
    // Immediate healthy attention avoids waiting for the effective 25s default.
    f.seed(targets[999]!.runId, "succeeded");
    const admitted = await bounded(f.raw(bytes).done);
    expect(admitted.status).toBe(200);
    const result = RunWaitManyResult.parse(JSON.parse(admitted.body));
    expect(result.wakeReason).toBe("attention");
    expect(result.attention).toEqual([999]);
    expect(result.summaries).toHaveLength(1000);
    expect(result.summaries[999]).toMatchObject({ status: "succeeded", problem: null });
    expect(f.snapshot).toHaveBeenCalledOnce();
    expect(f.snapshot.mock.calls[0]![0]).toEqual(targets.map((target) => target.runId));
    expect(f.subscribe).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);

    f.snapshot.mockClear();
    f.subscribe.mockClear();
    const overLimit = {
      targets: [...targets.slice(0, 999), { runId: "€" + "é".repeat(12) + "x".repeat(243) }],
    };
    const overBytes = JSON.stringify(overLimit);
    expect(Buffer.byteLength(overBytes, "utf8")).toBe(1_048_577);
    const refused = await bounded(f.raw(overBytes).done);
    expect(refused.status).toBe(413);
    ControlProblem.parse(JSON.parse(refused.body));
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.subscribe).not.toHaveBeenCalled();
  });

  it.each(["chunked", "content-length"] as const)(
    "rejects streamed %s excess before upload completion instead of buffering the advertised remainder",
    async (framing) => {
      const f = await fixture();
      const pending = f.raw(
        undefined,
        "/v2/runs/wait-many",
        framing === "chunked"
          ? { "transfer-encoding": "chunked" }
          : { "content-length": String(20 * RUN_WAIT_MANY_REQUEST_BYTES) },
      );
      pending.client.flushHeaders();
      const prefix = paddedBody(RUN_WAIT_MANY_REQUEST_BYTES);
      const upload = (async () => {
        for (let offset = 0; offset < prefix.length; offset += 32_768)
          await write(pending.client, prefix.subarray(offset, offset + 32_768));
        pending.client.write(Buffer.from(" "), () => {});
      })();
      // A declared oversized Content-Length may be refused before any body read.
      // Observe that response even if the in-progress client write then fails.
      void upload.catch(() => {});
      // The server must reject now. The client intentionally never ends the body
      // or sends the remaining advertised 19MiB; waiting for either is a failure.
      const response = await bounded(pending.done);
      expect(pending.client.writableEnded).toBe(false);
      expect(response.status).toBe(413);
      ControlProblem.parse(JSON.parse(response.body));
      expect(f.snapshot).not.toHaveBeenCalled();
      expect(f.subscribe).not.toHaveBeenCalled();
      pending.client.destroy();
      await bounded(Promise.allSettled([upload]));
    },
  );

  it("retains the existing shared-reader 10MiB default for old callers", async () => {
    const f = await fixture();
    const json = JSON.stringify({ protocolMajor: 3, client: "wait-many-http-fixture" });
    const body = Buffer.concat([
      Buffer.from(json),
      Buffer.alloc(10 * 1024 * 1024 - Buffer.byteLength(json), 0x20),
    ]);
    const response = await bounded(f.raw(body, "/v2/handshake").done);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ compatible: true, protocolMajor: 3 });
    expect(f.snapshot).not.toHaveBeenCalled();
  });

  it("keeps strict UTF-8 rejection in the shared reader before schema/discovery", async () => {
    const f = await fixture();
    const bytes = Buffer.concat([
      Buffer.from('{"targets":[{"runId":"'),
      Buffer.from([0xff]),
      Buffer.from('"}],"waitMs":0}'),
    ]);
    const response = await bounded(f.raw(bytes).done);
    expect(response.status).toBe(400);
    expect(ControlProblem.parse(JSON.parse(response.body)).code).toBe("invalid_encoding");
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.subscribe).not.toHaveBeenCalled();
  });

  it("accepts valid multibyte UTF-8 split between real HTTP writes and trims handles", async () => {
    const f = await fixture();
    f.seed("ж", "succeeded");
    const bytes = Buffer.from(JSON.stringify({ targets: [{ runId: " ж " }], waitMs: 0 }));
    const split = bytes.indexOf(Buffer.from("ж")) + 1;
    const pending = f.raw();
    await write(pending.client, bytes.subarray(0, split));
    pending.client.end(bytes.subarray(split));
    const response = await bounded(pending.done);
    expect(response.status).toBe(200);
    expect(RunWaitManyResult.parse(JSON.parse(response.body))).toEqual({
      wakeReason: "attention",
      attention: [0],
      summaries: await f.read(["ж"]),
    });
    expect(f.snapshot.mock.calls[0]![0]).toEqual(["ж"]);
  });
});
