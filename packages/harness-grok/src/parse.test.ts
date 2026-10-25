import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { validateTypedStream } from "@claudexor/core";
import { createGrokParser, grokFailure } from "./parse.js";

describe("Grok finality and vendor failures", () => {
  it("maps a terminal quota fixture without losing spend or creating an answer", () => {
    const parser = createGrokParser();
    const events = readFileSync(new URL("../fixtures/errors/quota.jsonl", import.meta.url), "utf8")
      .trim()
      .split("\n")
      .flatMap((line) => parser.parseEvent(JSON.parse(line), "s") ?? []);
    const stats = validateTypedStream(events);
    expect(stats.errors).toBe(1);
    expect(stats.usageEvents).toBe(1);
    expect(events.find((event) => event.rate_limit)?.rate_limit?.retry_delay_ms).toBe(60_000);
    expect(events.some((event) => event.final)).toBe(false);
  });
  it("counts aggregate usage once and keeps assistant narration non-final", () => {
    const p = createGrokParser();
    const message = p.parseEvent(
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "draft" }], usage: { input_tokens: 99 } },
      },
      "s",
    )!;
    expect(message[0]?.final).toBeUndefined();
    const result = {
      type: "result",
      subtype: "success",
      result: "answer",
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5 },
    };
    const events = p.parseEvent(result, "s")!;
    expect(events).toMatchObject([
      { type: "message", text: "answer", final: true },
      { type: "usage", usage: { input_tokens: 3, output_tokens: 4, cached_input_tokens: 5 } },
    ]);
    expect(p.parseEvent(result, "s")).toEqual([]);
    validateTypedStream([...message, ...events]);
  });

  it("uses structured output rather than mixed narration", () => {
    const events = createGrokParser().parseEvent(
      { type: "result", subtype: "success", structured_output: { ok: true }, result: "mixed" },
      "s",
    );
    expect(events?.[0]).toMatchObject({ final: true, text: '{"ok":true}' });
  });

  it.each(["rate_limit_exceeded", "quota_exceeded", "usage_limit_exceeded", "resource_exhausted"])(
    "types %s with reset and retry evidence",
    (code) => {
      const event = grokFailure(
        { code, message: "rejected", retry_after: 2, resets_at: "2026-10-26T01:00:00Z" },
        "s",
      );
      expect(event.rate_limit).toEqual({
        retry_delay_ms: 2000,
        resets_at: "2026-10-26T01:00:00.000Z",
        applies_to_models: null,
      });
      validateTypedStream([event]);
    },
  );

  it("types stderr-only quota refusals but never quota words in model prose", () => {
    expect(grokFailure("HTTP 429: Too many requests", "s").rate_limit).toBeTruthy();
    const p = createGrokParser();
    expect(
      p.parseEvent(
        { type: "result", subtype: "success", result: "quota exceeded is an error message" },
        "s",
      )?.[0]?.rate_limit,
    ).toBeUndefined();
  });

  it("does not report a failed or empty result as a final answer", () => {
    for (const result of [
      {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        errors: ["Maximum turns reached"],
      },
      { type: "result", subtype: "success", result: "" },
    ]) {
      const events = createGrokParser().parseEvent(result, "s")!;
      expect(events.some((event) => event.type === "error")).toBe(true);
      expect(events.some((event) => event.final)).toBe(false);
    }
  });

  it("does not fabricate a file change from a failed write", () => {
    const p = createGrokParser();
    p.parseEvent(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "call", name: "write", input: { file_path: "/workspace/a" } },
          ],
        },
      },
      "s",
    );
    const events = p.parseEvent(
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "call", is_error: true, content: "denied" },
          ],
        },
      },
      "s",
    )!;
    expect(events).toHaveLength(1);
    expect(events[0]?.tool).toMatchObject({ status: "error", target: "/workspace/a" });
    validateTypedStream(events);
  });

  it("does not infer successful writes from a statusless tool result", () => {
    const p = createGrokParser();
    p.parseEvent(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "call", name: "write", input: { file_path: "/workspace/a" } },
          ],
        },
      },
      "s",
    );
    const events = p.parseEvent(
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "call", content: "done" }] },
      },
      "s",
    )!;
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("status");
    validateTypedStream(events);
  });

  it("handles unknown/malformed events without throwing", () => {
    for (const raw of [null, [], { type: "future" }, { type: {} }])
      expect(createGrokParser().parseEvent(raw, "s")).toBeNull();
    expect(
      createGrokParser().parseEvent({ type: "assistant", message: { content: {} } }, "s"),
    ).toEqual([]);
  });
});
