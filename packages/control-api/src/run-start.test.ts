import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findAcceptedAroundPreflight,
  normalizeExistingProjectRoot,
  normalizeRunStartRequest,
} from "./run-start.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("normalizeExistingProjectRoot", () => {
  it("accepts a symlink to an existing directory and preserves its spelling", () => {
    const parent = mkdtempSync(join(tmpdir(), "claudexor-root-symlink-"));
    const target = mkdtempSync(join(tmpdir(), "claudexor-root-target-"));
    roots.push(parent, target);
    const linked = join(parent, "project-link");
    symlinkSync(target, linked, "dir");

    expect(normalizeExistingProjectRoot(`  ${linked}  `)).toBe(linked);
  });

  it("keeps missing paths and regular files on the same typed refusal", () => {
    const parent = mkdtempSync(join(tmpdir(), "claudexor-root-invalid-"));
    roots.push(parent);
    const file = join(parent, "file.txt");
    writeFileSync(file, "not a directory");

    for (const value of [join(parent, "missing"), file]) {
      try {
        normalizeExistingProjectRoot(value);
        throw new Error("expected project-root refusal");
      } catch (error) {
        expect(error).toMatchObject({ status: 400 });
        expect(String(error)).toContain("does not exist or is not a directory");
      }
    }
  });
});

describe("findAcceptedAroundPreflight", () => {
  it("returns an earlier accepted command without invoking mutable preflight", async () => {
    const accepted = { id: "job-prior" };
    let preflights = 0;
    await expect(
      findAcceptedAroundPreflight(
        async () => accepted,
        async () => {
          preflights += 1;
          throw new Error("mutable capability disappeared");
        },
      ),
    ).resolves.toBe(accepted);
    expect(preflights).toBe(0);
  });

  it("returns a command accepted while a failing mutable preflight was in flight", async () => {
    const accepted = { id: "job-raced" };
    let durable: typeof accepted | null = null;
    let releasePreflight!: () => void;
    const preflightEntered = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    let probes = 0;

    const result = findAcceptedAroundPreflight(
      async () => {
        probes += 1;
        return durable;
      },
      async () => {
        await preflightEntered;
        throw new Error("mutable capability disappeared");
      },
    );
    durable = accepted;
    releasePreflight();

    await expect(result).resolves.toBe(accepted);
    expect(probes).toBe(2);
  });

  it("preserves the original preflight error when the race-closing probe misses", async () => {
    const preflightError = new Error("mutable capability disappeared");
    await expect(
      findAcceptedAroundPreflight(
        async () => null,
        async () => {
          throw preflightError;
        },
      ),
    ).rejects.toBe(preflightError);
  });

  it("keeps custody unknown when the race-closing durable lookup cannot be read", async () => {
    const preflightError = Object.assign(new Error("retired access"), {
      status: 409,
      code: "retired_access_profile",
      retryable: false,
      requiredActions: ["Choose an active access profile."],
    });
    const lookupError = new Error("durable command index unavailable");
    let probes = 0;
    await expect(
      findAcceptedAroundPreflight(
        async () => {
          probes += 1;
          if (probes === 1) return null;
          throw lookupError;
        },
        async () => {
          throw preflightError;
        },
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "idempotency_status_unavailable",
      retryable: true,
      cause: lookupError,
      context: {
        stage: "lookup_after_preflight",
        cause: {
          message: "durable command index unavailable",
          requiredActions: [],
          context: {},
        },
        preflight: {
          message: "retired access",
          code: "retired_access_profile",
          status: 409,
          retryable: false,
          requiredActions: ["Choose an active access profile."],
          context: {},
        },
      },
    });
    expect(probes).toBe(2);
  });

  it("surfaces the daemon's typed project_not_registered as a 404, not an unknown custody 503", async () => {
    // The daemon socket carries code/status/retryable but drops requiredActions.
    const transported = Object.assign(new Error("project is not registered: /tmp/unregistered"), {
      code: "project_not_registered",
      status: 404,
      retryable: false,
    });
    let preflights = 0;
    const refusal = await findAcceptedAroundPreflight(
      async () => {
        throw transported;
      },
      async () => {
        preflights += 1;
      },
    ).catch((error: unknown) => error);
    expect(refusal).toBe(transported);
    expect(refusal).toMatchObject({
      status: 404,
      code: "project_not_registered",
      retryable: false,
      requiredActions: [expect.stringMatching(/POST \/v2\/projects.*scope\.ephemeral=true/)],
    });
    expect(preflights).toBe(0);
  });

  it("keeps an unrelated lookup failure on the retryable 503", async () => {
    await expect(
      findAcceptedAroundPreflight(
        async () => {
          throw Object.assign(new Error("journal partition quarantined"), {
            code: "partition_unavailable",
            status: 503,
          });
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "idempotency_status_unavailable",
      retryable: true,
      context: {
        stage: "lookup_before_preflight",
        cause: {
          code: "partition_unavailable",
          status: 503,
          message: "journal partition quarantined",
        },
      },
    });
  });

  it.each([
    ["idempotency_conflict", 409],
    ["invalid_idempotency_key", 400],
  ])("preserves the canonical %s refusal and its original facts", async (code, status) => {
    const error = Object.assign(new Error("canonical lookup refusal"), {
      code,
      status,
      context: { detail: "original evidence" },
      requiredActions: ["Original remedy."],
    });
    const result = await findAcceptedAroundPreflight(
      async () => {
        throw error;
      },
      async () => {
        throw new Error("must not reach preflight");
      },
    ).catch((failure: unknown) => failure);
    expect(result).toBe(error);
    expect(result).toMatchObject({
      code,
      status,
      retryable: false,
      context: { detail: "original evidence" },
      requiredActions: ["Original remedy."],
    });
  });
});

describe("ephemeral project roots", () => {
  it("carries the one-shot declaration through normalization", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-ephemeral-root-"));
    roots.push(root);

    const declared = normalizeRunStartRequest({
      prompt: "do the thing",
      mode: "agent",
      scope: { kind: "project", root, ephemeral: true },
    });
    // The scope is rebuilt field-by-field during normalization; dropping the
    // flag here would silently register the disposable tree after all.
    expect(declared.scope).toEqual({ kind: "project", root, context: "auto", ephemeral: true });

    const ordinary = normalizeRunStartRequest({
      prompt: "do the thing",
      mode: "agent",
      scope: { kind: "project", root },
    });
    expect(ordinary.scope).toEqual({ kind: "project", root, context: "auto", ephemeral: false });
  });
});

describe("readonly strategy admission", () => {
  it.each([
    { attempts: 2 },
    { untilClean: true },
    { tests: [{ program: "sh", args: ["-c", "true"], envAllowlist: [] }] },
  ])("refuses write-backed controls before enqueue (%o)", (strategy) => {
    try {
      normalizeRunStartRequest({
        prompt: "repair without write access",
        mode: "agent",
        access: "readonly",
        ...strategy,
      });
      throw new Error("expected readonly strategy refusal");
    } catch (error) {
      expect(error).toMatchObject({
        status: 400,
        code: "strategy_access_incompatible",
        retryable: false,
        requiredActions: [expect.stringMatching(/workspace_write\/full/)],
      });
    }
  });
});

describe("delegated execution.workspaceRoot", () => {
  function pair() {
    const parent = mkdtempSync(join(tmpdir(), "claudexor-workspace-root-"));
    roots.push(parent);
    const project = join(parent, "stable-project");
    const execution = join(parent, "execution-tree");
    mkdirSync(project);
    mkdirSync(execution);
    return { project, execution };
  }

  it("preserves stable project identity separately from the execution tree", () => {
    const { project, execution } = pair();
    const request = normalizeRunStartRequest({
      prompt: "edit the private tree",
      mode: "agent",
      scope: { kind: "project", root: project },
      execution: { isolation: "live", delegated: true, workspaceRoot: execution },
      access: "workspace_write",
    });
    expect(request.scope).toMatchObject({ kind: "project", root: project });
    expect(request.execution.workspaceRoot).toBe(execution);
  });

  it("requires the field on fresh mutating delegated live runs", () => {
    const { project } = pair();
    expect(() =>
      normalizeRunStartRequest({
        prompt: "edit",
        mode: "agent",
        scope: { kind: "project", root: project },
        execution: { isolation: "live", delegated: true },
        access: "workspace_write",
      }),
    ).toThrow(/workspaceRoot is required/);
    expect(
      normalizeRunStartRequest({
        prompt: "inspect",
        mode: "agent",
        scope: { kind: "project", root: project },
        execution: { isolation: "live", delegated: true },
        access: "readonly",
      }).access,
    ).toBe("readonly");
    // Omitted Agent access is project-configured and cannot be guessed by this
    // filesystem-only normalizer. The project-aware preflight resolves it.
    expect(
      normalizeRunStartRequest({
        prompt: "use the project default",
        mode: "agent",
        scope: { kind: "project", root: project },
        execution: { isolation: "live", delegated: true },
      }).execution.workspaceRoot,
    ).toBeUndefined();
  });

  it("refuses relative, missing, and non-external workspace declarations", () => {
    const { project } = pair();
    const base = {
      prompt: "edit",
      mode: "agent" as const,
      scope: { kind: "project" as const, root: project },
      access: "workspace_write" as const,
    };
    expect(() =>
      normalizeRunStartRequest({
        ...base,
        execution: { isolation: "live", delegated: true, workspaceRoot: "relative/tree" },
      }),
    ).toThrow(/absolute path/);
    expect(() =>
      normalizeRunStartRequest({
        ...base,
        execution: {
          isolation: "live",
          delegated: true,
          workspaceRoot: join(project, "missing"),
        },
      }),
    ).toThrow(/does not exist/);
    expect(() =>
      normalizeRunStartRequest({
        ...base,
        execution: { isolation: "live", delegated: false, workspaceRoot: project },
      }),
    ).toThrow(/only for project-scoped delegated runs/);
  });

  it("allows bounded legacy Exact Retry but revalidates a frozen new-shape workspace", () => {
    const { project, execution } = pair();
    expect(
      normalizeRunStartRequest({
        prompt: "legacy retry",
        mode: "agent",
        scope: { kind: "project", root: project },
        execution: { isolation: "live", delegated: true },
        access: "workspace_write",
        retryOf: "run-old",
      }).execution.workspaceRoot,
    ).toBeUndefined();
    rmSync(execution, { recursive: true, force: true });
    expect(() =>
      normalizeRunStartRequest({
        prompt: "new-shape retry",
        mode: "agent",
        scope: { kind: "project", root: project },
        execution: { isolation: "live", delegated: true, workspaceRoot: execution },
        access: "workspace_write",
        retryOf: "run-new",
      }),
    ).toThrow(/does not exist/);
  });
});

describe("execution.auxiliaryWritableRoots at the run-start boundary", () => {
  function fixture() {
    const parent = mkdtempSync(join(tmpdir(), "claudexor-aux-start-"));
    roots.push(parent);
    const project = join(parent, "project");
    const cache = join(parent, "cache");
    mkdirSync(project);
    mkdirSync(cache);
    const link = join(parent, "cache-link");
    symlinkSync(cache, link);
    return { project, cache, link, missing: join(parent, "missing") };
  }
  const start = (project: string, roots: string[], extra: Record<string, unknown> = {}) =>
    normalizeRunStartRequest({
      prompt: "bootstrap",
      mode: "agent",
      scope: { kind: "project", root: project },
      execution: { auxiliaryWritableRoots: roots },
      ...extra,
    });
  const refusal = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new Error("expected a typed refusal");
  };

  it("keeps the caller spelling; canonicalization belongs to engine admission", () => {
    const { project, link } = fixture();
    expect(start(project, [link]).execution.auxiliaryWritableRoots).toEqual([link]);
    expect(start(project, []).execution.auxiliaryWritableRoots).toEqual([]);
  });

  it("refuses relative and missing paths, deferring only existence for thread-bound runs", () => {
    const { project, missing } = fixture();
    expect(refusal(() => start(project, ["cache"]))).toMatchObject({
      code: "auxiliary_writable_root_invalid",
      status: 400,
      retryable: false,
    });
    expect(refusal(() => start(project, [missing]))).toMatchObject({
      code: "auxiliary_writable_root_invalid",
      retryable: true,
    });
    const deferred = (roots: string[]) =>
      normalizeRunStartRequest(
        {
          prompt: "turn",
          mode: "agent",
          scope: { kind: "project", root: project },
          execution: { auxiliaryWritableRoots: roots },
        },
        { deferExecutionWorkspaceAvailability: true },
      );
    expect(deferred([missing]).execution.auxiliaryWritableRoots).toEqual([missing]);
    expect(refusal(() => deferred(["cache"]))).toMatchObject({
      code: "auxiliary_writable_root_invalid",
    });
  });

  it("refuses read-only modes and explicit non-workspace_write access, never changing access", () => {
    const { project, cache } = fixture();
    for (const extra of [
      { mode: "ask" },
      { mode: "plan" },
      { access: "readonly" },
      { access: "full" },
      { access: "inherit_native" },
    ]) {
      expect(refusal(() => start(project, [cache], extra))).toMatchObject({
        code: "auxiliary_writable_roots_access_conflict",
        status: 400,
      });
    }
    // An omitted Agent access is the project default: the preflight decides it.
    expect(start(project, [cache]).access).toBeUndefined();
    expect(start(project, [cache], { access: "workspace_write" }).access).toBe("workspace_write");
  });
});
