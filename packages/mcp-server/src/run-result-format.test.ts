import { describe, expect, it } from "vitest";
import { McpRunToolResult } from "@claudexor/schema";
import { formatRunResult, structuredRunResult } from "./run-result-format.js";

describe("launch handle mirrors", () => {
  it("carries a queued job id in text and structured content", () => {
    const queued = {
      summary: "accepted as job job-q",
      jobId: "job-q",
      runId: "",
      status: "queued",
    };
    expect(formatRunResult(queued)).toBe("accepted as job job-q\n\njobId: job-q\nstatus: queued");
    expect(McpRunToolResult.parse(structuredRunResult(queued))).toMatchObject({
      jobId: "job-q",
      runId: null,
      status: "queued",
    });
  });

  it("names both handles of a bound run and an unknown state as null", () => {
    const bound = { summary: "run running", jobId: "job-1", runId: "run-1", status: "" };
    expect(formatRunResult(bound)).toBe("run running\n\nrunId: run-1\njobId: job-1");
    expect(structuredRunResult(bound)).toMatchObject({
      jobId: "job-1",
      runId: "run-1",
      status: null,
    });
  });
});
