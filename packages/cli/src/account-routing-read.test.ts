import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import AjvModule from "ajv";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DaemonControlApiServer,
  OPERATION_CATALOG,
  type DaemonFacadeClient,
} from "@claudexor/control-api";
import { defaultClaudexorTools } from "@claudexor/mcp-server";
import {
  ControlCredentialProfilesResponse,
  ControlCredentialProfilesSnapshotResponse,
} from "@claudexor/schema";

// Real loopback consumers of the additive Accounts read: the control route, the
// CLI commands over their real daemonGet/controlApiFetch HTTP path, and the MCP
// accounts query, against a current daemon, an older daemon that predates the
// route (404) and a daemon whose auxiliary read fails (500). Only daemon
// discovery is pointed at the loopback server.

const target = vi.hoisted(() => ({ addr: { baseUrl: "", token: "fixture" } }));
vi.mock("./daemon-run.js", async (original) => ({
  ...(await original<typeof import("./daemon-run.js")>()),
  ensureDaemon: async () => ({ addr: target.addr }),
  connectDaemonIfRunning: async () => ({ addr: target.addr }),
}));
const { accountsCommandWithDeps, profilesCommandWithDeps } =
  await import("./credential-commands.js");
const { catalogQuery } = await import("./mcp-catalog-query.js");
const { parseArgs } = await import("./args.js");

const Ajv = AjvModule.default ?? (AjvModule as unknown as typeof AjvModule.default);

const profile = {
  profile_id: "work",
  harness_id: "claude",
  display_name: "Work",
  credential_kind: "config_dir_login",
  isolation_locator: "/tmp/claudexor-routing-read/claude-work",
  secret_ref: null,
  enabled: true,
  created_at: null,
};
const status = {
  profile_id: "work",
  harness_id: "claude",
  availability: "available",
  verification: "passed",
};
const pools = [
  {
    harness_id: "claude",
    next_up: { kind: "none", reason: "no enabled account is ready (work: probe unanswered)" },
  },
  { harness_id: "codex", next_up: { kind: "api_key_route" } },
];
const listing = ControlCredentialProfilesResponse.parse({
  profiles: [{ profile, status, identity: null }],
  harnessAccounts: [],
  accountPools: pools,
});
const snapshot = ControlCredentialProfilesSnapshotResponse.parse({
  ...listing,
  harnesses: [{ id: "claude", status: "ok" }],
  git: { status: "available", version: null, detail: null, remediation: null },
  quota: { snapshots: [], refreshed_at: null },
  quotaEventCursor: "q-1",
});
const evidence = {
  capabilities: [
    {
      harness_id: "claude",
      profile_id: "work",
      requested_model: "unsupported-model",
      account_fingerprint: "work-identity",
      provider_reason: "Model unavailable for this account. " + "More detail. ".repeat(20),
      observed_at: "2026-10-13T08:00:00.000Z",
      expires_at: "2026-10-13T12:00:00.000Z",
      state: "probe_due",
    },
    {
      harness_id: "claude",
      profile_id: "another-account",
      requested_model: "other-account-model",
      account_fingerprint: null,
      provider_reason: "Not supported",
      observed_at: "2026-10-13T08:00:00.000Z",
      expires_at: "2099-01-01T00:00:00.000Z",
      state: "confirmed",
    },
  ],
  refusals: [
    {
      harness_id: "claude",
      profile_id: "work",
      requested_model: "claude-opus-5-5",
      observed_at: "2026-10-13T08:00:00.000Z",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
    {
      harness_id: "claude",
      profile_id: "work",
      requested_model: "expired-model",
      observed_at: "2020-01-01T00:00:00.000Z",
      expires_at: "2020-01-01T01:00:00.000Z",
    },
  ],
  lastService: [
    {
      harness_id: "claude",
      profile_id: "work",
      requested_model: null,
      observed_at: "2026-10-13T07:00:00.000Z",
    },
  ],
};

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  vi.restoreAllMocks();
});

/** A current daemon: the legacy listing plus the additive read (or its failure). */
async function currentDaemon(read: () => Promise<unknown> = async () => evidence) {
  const credentialProfiles = vi.fn(async (input?: { snapshot?: boolean }) =>
    input?.snapshot ? snapshot : listing,
  );
  const server = new DaemonControlApiServer({
    token: "fixture",
    daemon: {} as DaemonFacadeClient,
    services: { credentialProfiles, accountRoutingEvidence: vi.fn(read) },
  });
  const { host, port } = await server.start();
  closers.push(() => server.stop());
  target.addr = { baseUrl: `http://${host}:${port}`, token: "fixture" };
  return target.addr.baseUrl;
}

/** An engine that predates the read: same listing, 404 for the new path. */
async function olderDaemon() {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/v2/credential-profiles")
      return send(200, url.searchParams.get("snapshot") === "true" ? snapshot : listing);
    send(404, { code: "not_found", message: `no route for ${url.pathname}`, retryable: false });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  closers.push(() => new Promise<void>((done) => server.close(() => done())));
  const { port } = server.address() as AddressInfo;
  target.addr = { baseUrl: `http://127.0.0.1:${port}`, token: "fixture" };
}

function capture() {
  let stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as never);
  return () => stdout;
}
const headers = { authorization: "Bearer fixture", "X-Claudexor-Protocol-Major": "3" };
const accountsOutput = () =>
  defaultClaudexorTools(async () => ({})).find((tool) => tool.name === "claudexor_accounts")!
    .outputSchema!;

describe("GET /v2/accounts/routing-evidence on a real loopback server", () => {
  it("is advertised read-only and served strict, while the legacy listing keeps its exact shape", async () => {
    const operation = OPERATION_CATALOG.operations.find(
      (op) => op.id === "get:accounts.routing-evidence",
    );
    expect(operation).toMatchObject({
      method: "GET",
      path: "/v2/accounts/routing-evidence",
      mutability: "read_only",
      responseSchema: "ControlAccountRoutingEvidenceResponse",
    });
    const base = await currentDaemon();
    const read = await fetch(`${base}/v2/accounts/routing-evidence`, { headers });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(evidence);
    expect((await fetch(`${base}/v2/accounts/routing-evidence?model=x`, { headers })).status).toBe(
      400,
    );
    const catalog = (await (await fetch(`${base}/v2/operations`, { headers })).json()) as {
      operations: Array<{ id: string }>;
    };
    expect(catalog.operations.map((op) => op.id)).toContain("get:accounts.routing-evidence");
    for (const [path, body] of [
      ["/v2/credential-profiles", listing],
      ["/v2/credential-profiles?snapshot=true", snapshot],
    ] as const) {
      const legacy = (await (await fetch(`${base}${path}`, { headers })).json()) as object;
      expect(legacy).toEqual(body);
      expect(Object.keys(legacy)).not.toContain("routingEvidence");
    }
  });
});

describe("CLI and MCP consumers of the additive read", () => {
  it("a current daemon: model-scoped refusal and last-served lines, next-up labelled as the default model's", async () => {
    await currentDaemon();
    let out = capture();
    expect(await profilesCommandWithDeps(parseArgs(["profiles"]), false)).toBe(0);
    expect(out()).toContain(
      "    recent refusal · claude-opus-5-5 · observed 2026-10-13T08:00:00.000Z",
    );
    expect(out()).toContain("    last served · default model · 2026-10-13T07:00:00.000Z");
    expect(out()).toContain(
      "    model capability · unsupported-model · probe_due · since 2026-10-13T08:00:00.000Z, next probe 2026-10-13T12:00:00.000Z · " +
        evidence.capabilities[0]!.provider_reason.slice(0, 159) +
        "…",
    );
    expect(out()).not.toContain(evidence.capabilities[0]!.provider_reason);
    expect(out()).not.toContain("other-account-model");
    expect(out()).not.toContain("expired-model");
    // The none reason and the paid route disclosure are retained, qualified.
    expect(out()).toContain(
      "next up (default model): nothing routable (no enabled account is ready (work: probe unanswered))",
    );
    expect(out()).toContain("next up (default model): API key (paid route)");
    vi.restoreAllMocks();
    out = capture();
    expect(await accountsCommandWithDeps(parseArgs(["accounts"]), false)).toBe(0);
    expect(out()).toContain("recent refusal · claude-opus-5-5");
    expect(out()).toContain("model capability · unsupported-model · probe_due");
    expect(out()).toContain("next up (default model) codex: API key route");
    vi.restoreAllMocks();
    out = capture();
    expect(await accountsCommandWithDeps(parseArgs(["accounts", "--json"]), true)).toBe(0);
    expect(JSON.parse(out())).toEqual({ ...snapshot, routingEvidence: evidence });
    // MCP: the joined structured output validates against the declared output schema.
    const joined = await catalogQuery("__accounts");
    expect(joined).toEqual({ ...listing, routingEvidence: evidence });
    const validate = new Ajv({ strict: false, allErrors: true }).compile(accountsOutput());
    expect(validate(joined), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(await catalogQuery("__accounts", false, { fresh: true }))).toBe(true);
    // Still strict: an invented key is not part of the contract.
    expect(validate({ ...joined, invented: true })).toBe(false);
  });

  it("an older daemon (404): the listing is unchanged, no new lines, no diagnostic", async () => {
    await olderDaemon();
    let out = capture();
    expect(await profilesCommandWithDeps(parseArgs(["profiles"]), false)).toBe(0);
    expect(out()).toContain("work [config_dir_login] available");
    expect(out()).not.toContain("recent refusal");
    expect(out()).not.toContain("model capability");
    expect(out()).not.toContain("routing evidence unavailable");
    vi.restoreAllMocks();
    out = capture();
    expect(await profilesCommandWithDeps(parseArgs(["profiles", "--json"]), true)).toBe(0);
    expect(JSON.parse(out())).toEqual(listing);
    const legacy = await catalogQuery("__accounts");
    expect(legacy).toEqual(listing);
    const validate = new Ajv({ strict: false }).compile(accountsOutput());
    expect(validate(legacy)).toBe(true);
  });

  it("an auxiliary failure (500) keeps the listing authoritative and adds one diagnostic", async () => {
    await currentDaemon(async () => {
      throw Object.assign(new Error("account evidence store unavailable"), { status: 500 });
    });
    let out = capture();
    expect(await profilesCommandWithDeps(parseArgs(["profiles"]), false)).toBe(0);
    expect(out()).toContain("work [config_dir_login] available");
    expect(out().match(/routing evidence unavailable/g)).toHaveLength(1);
    vi.restoreAllMocks();
    out = capture();
    expect(await accountsCommandWithDeps(parseArgs(["accounts", "--json"]), true)).toBe(0);
    const json = JSON.parse(out()) as Record<string, unknown>;
    expect(json["profiles"]).toEqual(snapshot.profiles);
    expect(json["routingEvidence"]).toBeUndefined();
    expect(String(json["routingEvidenceProblem"])).toContain("routing evidence unavailable");
    const degraded = await catalogQuery("__accounts");
    expect(degraded["profiles"]).toEqual(listing.profiles);
    expect(String(degraded["routingEvidenceProblem"])).toContain("routing evidence unavailable");
    const validate = new Ajv({ strict: false }).compile(accountsOutput());
    expect(validate(degraded)).toBe(true);
  });
});
