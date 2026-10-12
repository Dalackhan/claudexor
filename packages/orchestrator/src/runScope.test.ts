import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CLAUDEXOR_HOME_SCOPED_ENV,
  isRunScopeMarkerName,
  mintRunScopeMarker,
  runCapture,
  spawnProcess,
  type HarnessAdapter,
  type ScopeReapOutcome,
} from "@claudexor/core";
import {
  ConformanceReport,
  HarnessManifest,
  RunProcessScopeOutcome,
  type HarnessRunSpec,
  type ProviderFamily,
} from "@claudexor/schema";
import type { ReviewerSpec } from "@claudexor/review";
import { ArtifactStore } from "@claudexor/artifact-store";
import { Orchestrator } from "./orchestrator.js";
import { inProcessRunScopeCustodian, scopedSpecEnv, type RunScopeCustodian } from "./runScope.js";

const reapDirs: string[] = [];
afterAll(() => {
  for (const dir of reapDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 30_000);

async function initRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-scope-"));
  reapDirs.push(repo);
  await runCapture("git", ["-C", repo, "init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  await runCapture("git", ["-C", repo, "add", "-A"]);
  await runCapture("git", [
    "-C",
    repo,
    "-c",
    "user.email=t@t.dev",
    "-c",
    "user.name=t",
    "commit",
    "-m",
    "init",
  ]);
  return repo;
}

/** An implementer that records every spec env it was launched with. */
function recordingImplementer(
  id: string,
  seen: HarnessRunSpec["env"][],
  body?: (spec: HarnessRunSpec) => AsyncGenerator<void>,
): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "local",
        capabilities: { implement: true },
        access_profiles_supported: ["workspace_write", "full"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["implement"],
      });
    },
    async *run(spec) {
      seen.push(spec.env);
      const ts = new Date().toISOString();
      yield {
        type: "started",
        session_id: spec.session_id,
        ts,
        credential_route: "managed_api_key",
      };
      if (body) for await (const _ of body(spec)) void _;
      writeFileSync(join(spec.cwd, "CHANGED.txt"), "real change\n");
      yield { type: "message", session_id: spec.session_id, ts, text: "Implemented." };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

function recordingReviewer(
  id: string,
  family: ProviderFamily,
  seen: HarnessRunSpec["env"][],
): ReviewerSpec {
  const adapter: HarnessAdapter = {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        capabilities: { review: true },
      });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["review"] });
    },
    async *run(spec) {
      seen.push(spec.env);
      const ts = new Date().toISOString();
      yield {
        type: "started",
        session_id: spec.session_id,
        ts,
        observed_model: `${id}-model`,
        credential_route: "managed_api_key",
      };
      yield { type: "message", session_id: spec.session_id, ts, text: "```json\n[]\n```" };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
  return { adapter, providerFamily: family };
}

function markerOf(env: HarnessRunSpec["env"] | undefined): string | undefined {
  return Object.keys(env ?? {}).find((key) => isRunScopeMarkerName(key) && env?.[key] === "1");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

describe("scopedSpecEnv", () => {
  const source = { HOME: "/Users/op", PATH: "/usr/bin" };
  it("adds the marker last and the host facts only for a scoped HOME, never rewriting the patch", () => {
    const marker = mintRunScopeMarker();
    const scoped = scopedSpecEnv(marker, { HOME: "/tmp/scoped", CODEX_HOME: "/x" }, { source });
    expect(scoped).toMatchObject({ HOME: "/tmp/scoped", CODEX_HOME: "/x", [marker]: "1" });
    expect(scoped?.[CLAUDEXOR_HOME_SCOPED_ENV]).toBe("1");
    const inPlace = scopedSpecEnv(marker, undefined, { source });
    expect(inPlace).toEqual({ [marker]: "1" });
    expect(scopedSpecEnv(undefined, { HOME: "/tmp/scoped" }, { source })).toEqual({
      HOME: "/tmp/scoped",
    });
  });
});

describe("Orchestrator run scope (item 1-2)", () => {
  it("mints ONE marker per run before the first launch, carries it in every candidate and reviewer env, and settles once at the end", async () => {
    const repo = await initRepo();
    const seen: HarnessRunSpec["env"][] = [];
    const reviewerSeen: HarnessRunSpec["env"][] = [];
    const calls: string[] = [];
    const custodian: RunScopeCustodian = {
      async open(runId) {
        calls.push(`open:${runId}`);
        const { marker } = await inProcessRunScopeCustodian.open(runId);
        return { marker };
      },
      async settle(runId, marker) {
        calls.push(`settle:${runId}`);
        return inProcessRunScopeCustodian.settle(runId, marker);
      },
    };
    const registry = new Map<string, HarnessAdapter>([
      [
        "impl",
        recordingImplementer("impl", seen, async function* () {
          calls.push("launch");
        }),
      ],
    ]);
    const res = await new Orchestrator({
      registry,
      runScopes: custodian,
      reviewers: [recordingReviewer("rev-a", "openai", reviewerSeen)],
    }).run({ repoRoot: repo, prompt: "do it", mode: "agent", harnesses: ["impl"], n: 2 });
    expect(res.lifecycle).toBe("succeeded");
    // Order: open, then every launch, then exactly one settle.
    expect(calls[0]).toMatch(/^open:/);
    expect(calls.filter((c) => c === "launch")).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith("settle:"))).toHaveLength(1);
    expect(calls.at(-1)).toMatch(/^settle:/);
    const markers = new Set(seen.map(markerOf));
    expect(markers.size).toBe(1);
    const [marker] = [...markers];
    expect(marker).toBeDefined();
    expect(reviewerSeen.length).toBeGreaterThan(0);
    for (const env of reviewerSeen) {
      expect(markerOf(env)).toBe(marker);
      // The reviewer runs under a scoped scratch HOME: it is told so.
      expect(env?.[CLAUDEXOR_HOME_SCOPED_ENV]).toBe("1");
    }
    const factsPath = join(res.runDir, "final", "process_scope.yaml");
    expect(existsSync(factsPath)).toBe(true);
    const facts = RunProcessScopeOutcome.parse(new ArtifactStore(repo).readYaml(factsPath));
    expect(facts.marker).toBe(marker);
    expect(facts.coverage).toBe("marker");
  }, 60_000);

  it("settles the scope exactly once even when the strategy fails", async () => {
    const repo = await initRepo();
    const calls: string[] = [];
    const custodian: RunScopeCustodian = {
      async open(runId) {
        calls.push("open");
        return inProcessRunScopeCustodian.open(runId);
      },
      async settle(runId, marker) {
        calls.push("settle");
        return inProcessRunScopeCustodian.settle(runId, marker);
      },
    };
    const failing: HarnessAdapter = {
      ...recordingImplementer("boom", []),
      // eslint-disable-next-line require-yield
      async *run() {
        throw new Error("vendor exploded");
      },
    };
    const res = await new Orchestrator({
      registry: new Map([["boom", failing]]),
      runScopes: custodian,
    }).run({ repoRoot: repo, prompt: "do it", mode: "agent", harnesses: ["boom"], n: 1 });
    expect(res.lifecycle).not.toBe("succeeded");
    expect(calls).toEqual(["open", "settle"]);
  }, 60_000);

  it.runIf(process.platform !== "win32")(
    "ends a reparented grandchild the harness left behind at the whole-run barrier and records it as ended",
    async () => {
      const repo = await initRepo();
      let orphan = 0;
      const outcomes: ScopeReapOutcome[] = [];
      const custodian: RunScopeCustodian = {
        open: (runId) => inProcessRunScopeCustodian.open(runId),
        async settle(runId, marker) {
          const outcome = await inProcessRunScopeCustodian.settle(runId, marker);
          outcomes.push(outcome);
          return outcome;
        },
      };
      // A real harness process (node) that starts a detached node grandchild
      // carrying the inherited env and exits — the #449 orphan shape with an
      // env-visible leftover; the platform-binary shape is covered in core by
      // the capture path, which the daemon index provides.
      const script =
        "const {spawn}=require('node:child_process');" +
        "const c=spawn(process.execPath,['-e','setTimeout(()=>{},600000)'],{detached:true,stdio:'ignore',env:process.env});" +
        "c.unref();console.log('orphan:'+c.pid);";
      const impl = recordingImplementer("impl", [], async function* (spec) {
        for await (const ev of spawnProcess(process.execPath, ["-e", script], {
          env: spec.env,
          cwd: spec.cwd,
        })) {
          if (ev.type === "stdout" && ev.line.startsWith("orphan:"))
            orphan = Number(ev.line.slice(7));
        }
        yield;
      });
      try {
        const res = await new Orchestrator({
          registry: new Map([["impl", impl]]),
          runScopes: custodian,
        }).run({ repoRoot: repo, prompt: "do it", mode: "agent", harnesses: ["impl"], n: 1 });
        expect(res.lifecycle).toBe("succeeded");
        expect(orphan).toBeGreaterThan(0);
        expect(alive(orphan)).toBe(false);
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]!.ended.map((m) => m.pid)).toContain(orphan);
        expect(outcomes[0]!.settled).toBe(true);
        const facts = RunProcessScopeOutcome.parse(
          new ArtifactStore(repo).readYaml(join(res.runDir, "final", "process_scope.yaml")),
        );
        expect(facts.ended.map((m) => m.pid)).toContain(orphan);
      } finally {
        if (orphan) {
          try {
            process.kill(orphan, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
    },
    60_000,
  );
});

// Keep `spawn` referenced for the platform-binary shape documented above.
void spawn;
