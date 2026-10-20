import { afterEach, describe, expect, it, vi } from "vitest";
import { McpRunToolResult } from "@claudexor/schema";
import { keyedLaunchNeedsProject, projectLaunchHandle } from "./mcp-launch-handle.js";

vi.mock("./live.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./live.js")>()),
  controlApiFetch: vi.fn(),
}));
import { controlApiFetch } from "./live.js";

const addr = { baseUrl: "http://local", token: "t" };
const failure = {
  phase: "preflight",
  category: "auth",
  code: null,
  harnessId: null,
  attemptId: null,
  safeMessage: "profile p1 is unknown",
  rawDetailRef: null,
  resetsAt: null,
  vendorFailure: null,
  logRefs: [],
  eventRefs: [],
  runDir: null,
  nextActions: ["Pick a registered profile."],
};

afterEach(() => vi.resetAllMocks());

describe("MCP launch handles", () => {
  it("keeps a still-queued job as a handle without reading detail", async () => {
    const result = await projectLaunchHandle(
      addr,
      { jobId: "job-q", runId: "", runDir: "", status: "queued" },
      { deferred: true, mode: "agent" },
    );
    expect(result).toMatchObject({ jobId: "job-q", runId: "", status: "queued" });
    expect(String(result["summary"])).toContain("Follow it with claudexor_run_wait");
    expect(controlApiFetch).not.toHaveBeenCalled();
  });

  it("reads a pre-run failure's typed detail by its job id", async () => {
    vi.mocked(controlApiFetch).mockResolvedValue(
      Response.json({ summary: { jobId: "job-f", runId: "job-f", state: "failed" }, failure }),
    );
    const result = await projectLaunchHandle(
      addr,
      { jobId: "job-f", runId: "", runDir: "", status: "failed", error: "profile p1 is unknown" },
      { deferred: true },
    );
    expect(vi.mocked(controlApiFetch).mock.calls[0]![1]).toBe("/runs/job-f");
    expect(result).toMatchObject({
      jobId: "job-f",
      status: "failed",
      summary: "profile p1 is unknown",
      failure: { category: "auth", safeMessage: "profile p1 is unknown" },
    });
  });

  it("keeps terminal-waiting (belt) reads on the bound run only", async () => {
    const result = await projectLaunchHandle(
      addr,
      { jobId: "job-f", runId: "", runDir: "", status: "failed", error: "refused" },
      { deferred: false, mode: "agent" },
    );
    expect(controlApiFetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ runId: "", jobId: "job-f", summary: "refused" });
  });

  it("names the keyed-launch project requirement as a typed usage refusal", () => {
    expect(keyedLaunchNeedsProject()).toMatchObject({
      category: "usage",
      code: "idempotency_repo_path_required",
      retryable: false,
    });
  });

  it("produces handles the declared MCP result schema accepts once mirrored", async () => {
    const { structuredRunResult } = await import("../../mcp-server/src/run-result-format.js");
    const handle = await projectLaunchHandle(
      addr,
      { jobId: "job-q", runId: "", runDir: "", status: "queued" },
      { deferred: true },
    );
    expect(McpRunToolResult.parse(structuredRunResult(handle))).toMatchObject({
      jobId: "job-q",
      runId: null,
      status: "queued",
    });
  });
});
