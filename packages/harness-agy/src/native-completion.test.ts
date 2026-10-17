import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "@claudexor/schema";
import { HarnessEvent as EventSchema, RunEvent } from "@claudexor/schema";
import { createAgyNativeCompletion } from "./native-completion.js";
import { parseAgyEvent } from "./parse.js";

// Sanitized minimal vendor diagnostic retained from an observed zero-exit
// AGY headless turn. No operator paths, account names, work orders or tool ids.
const diagnostic =
  'jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. read_file(<target>)).';
const event = (value: Partial<HarnessEvent>): HarnessEvent => ({
  type: "completed",
  session_id: "test",
  ts: "2026-10-15T00:00:00Z",
  ...value,
});
async function replay(events: HarnessEvent[]) {
  const out = [];
  for await (const e of createAgyNativeCompletion().wrap(
    (async function* () {
      yield* events;
    })(),
  ))
    out.push(EventSchema.parse(e));
  return out;
}
describe("AGY native permission evidence", () => {
  it("replays the native completion from the sanitized historical normalized recording", async () => {
    const rows = readFileSync(
      new URL("./test-support/normalized/headless-permission-denial.jsonl", import.meta.url),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => RunEvent.parse(JSON.parse(line)));
    expect(rows.map((row) => row.seq)).toEqual([20, 21, 22, 23]);
    // Historical error prose is evidence of what the old adapter said, not
    // today's classifier. Raw vendor stdout was not retained for this capture.
    expect(rows[0]!.payload["title"]).toContain("commonly a vendor soft-deny");
    const completion = EventSchema.parse(rows[2]!.payload);
    const out = await replay([completion]);
    expect(out[0]).toMatchObject({
      type: "error",
      permission_denial: { permission: "read_file", source: "agy_native_stderr" },
    });
    expect(out.at(-1)).toMatchObject({ type: "completed", payload: { exit_code: 0 } });
    expect(rows[3]!.payload["retry"]).toBe(1); // old behavior, not a current retry expectation
  });
  it.each([false, undefined])(
    "does not promote narration (final=%s) over a native denial",
    async (final) => {
      const out = await replay([
        event({ type: "message", text: "I will read the requested file.", final }),
        event({ payload: { stderr_tail: diagnostic, exit_code: 0 } }),
      ]);
      expect(out[1]).toMatchObject({
        type: "error",
        permission_denial: { permission: "read_file" },
      });
      expect(out.some((e) => e.type === "message" && e.final)).toBe(false);
    },
  );
  it("classifies only the native diagnostic, not empty output or model prose", async () => {
    for (const text of [
      "",
      "no output produced",
      "permission denied",
      "Some tool required permission",
    ]) {
      const out = await replay([event({ payload: { stderr_tail: text, exit_code: 0 } })]);
      expect(out.some((e) => e.permission_denial)).toBe(false);
    }
    const prose = await replay([
      event({ type: "message", text: diagnostic, final: true }),
      event({}),
    ]);
    expect(prose.some((e) => e.permission_denial)).toBe(false);
    const out = await replay([event({ payload: { stderr_tail: diagnostic, exit_code: 0 } })]);
    expect(out[0]).toMatchObject({
      type: "error",
      permission_denial: { permission: "read_file", source: "agy_native_stderr" },
    });
    expect(out.at(-1)!.type).toBe("completed");
    expect(out[0]).not.toHaveProperty("tool");
  });
  it("retains a later/partial answer and the refusal without claiming that the tool succeeded", async () => {
    const answer = event({ type: "message", text: "A useful partial answer", final: true });
    const out = await replay([
      answer,
      event({ payload: { stderr_tail: diagnostic, exit_code: 0 } }),
    ]);
    expect(out[0]).toMatchObject(answer);
    expect(out[1]).toMatchObject({
      type: "status",
      permission_denial: { permission: "read_file" },
    });
    expect(out.some((e) => e.type === "error")).toBe(false);
  });
  it("does not fabricate a successful read or file change from DONE without output", () => {
    const out = parseAgyEvent(
      {
        event: "step_update",
        step_update: {
          step_type: "tool",
          state: "DONE",
          tool_info: { name: "view_file", parameters: { TargetFile: "/fixture/input.md" } },
        },
      },
      "test",
    )!;
    expect(out).toMatchObject([{ type: "status", payload: { native_tool_state: "DONE" } }]);
    expect(out.some((e) => e.type === "tool_result" || e.type === "file_change")).toBe(false);
  });
  it("keeps DONE with actual read/write output as successful tool evidence", () => {
    for (const name of ["view_file", "write_to_file"]) {
      const out = parseAgyEvent(
        {
          event: "step_update",
          step_update: {
            step_type: "tool",
            state: "DONE",
            tool_info: {
              name,
              parameters: { TargetFile: "/fixture/input.md" },
              output: "actual tool output",
            },
          },
        },
        "test",
      )!.map((e) => EventSchema.parse(e));
      expect(out[0]).toMatchObject({
        type: "tool_result",
        tool: { name, status: "ok", content_summary: "actual tool output" },
      });
      expect(out.filter((e) => e.type === "file_change")).toEqual(
        name === "write_to_file"
          ? [expect.objectContaining({ payload: { path: "/fixture/input.md", tool: name } })]
          : [],
      );
      expect(out.some((e) => e.type === "status" || e.type === "error")).toBe(false);
    }
  });
});
