import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateTypedStream } from "@claudexor/core";
import { createGrokParser } from "./parse.js";

describe("Grok recorded stream conformance", () => {
  const fixtures = new URL("../fixtures/", import.meta.url);
  for (const name of readdirSync(fixtures).filter((name) => name.endsWith(".jsonl"))) {
    it(name, () => {
      const parser = createGrokParser();
      const events = readFileSync(new URL(name, fixtures), "utf8")
        .trim()
        .split("\n")
        .flatMap((line) => parser.parseEvent(JSON.parse(line), "fixture") ?? []);
      const stats = validateTypedStream(events);
      expect(stats.started).toBe(1);
      expect(stats.usageEvents).toBe(1);
      expect(stats.errors).toBe(0);
      expect(events.filter((event) => event.final)).toHaveLength(1);
      expect(events.find((event) => event.final)?.text).toBe("OK");
      expect(stats.statuslessToolResults).toBe(0);
      if (name === "write.jsonl") {
        expect(stats.toolCalls).toBeGreaterThan(0);
        expect(stats.toolResults).toBe(stats.toolCalls);
        expect(stats.fileChanges).toBe(1);
      }
    });
  }
});
