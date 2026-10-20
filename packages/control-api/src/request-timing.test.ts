import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ProcessTiming } from "@claudexor/util";
import { expect, it } from "vitest";
import { trackRequest } from "./request-timing.js";
import { OPERATION_CATALOG } from "./operation-catalog.js";

it("aggregates every catalog template and never retains URL identifiers or queries", () => {
  const timing = new ProcessTiming();
  for (const operation of OPERATION_CATALOG.operations) {
    for (let i = 0; i < 2; i++) {
      const url =
        operation.path.replace(/:[^/]+/g, `private-id-${i}`).replace("<path>", "private/path") +
        "?secret=fixture";
      const res = new EventEmitter() as ServerResponse;
      trackRequest({ method: operation.method, url } as IncomingMessage, res, timing);
      res.emit("finish");
      res.emit("close");
    }
  }
  const facts = timing.facts();
  expect(facts.routes).toHaveLength(OPERATION_CATALOG.operations.length);
  expect(facts.routes.every((route) => route.lifetime.count === 2)).toBe(true);
  expect(JSON.stringify(facts)).not.toMatch(/private-id|private\/path|secret=fixture/);
  expect(facts.routes.map((r) => `${r.method} ${r.route}`).sort()).toEqual(
    OPERATION_CATALOG.operations.map((o) => `${o.method} ${o.path}`).sort(),
  );
});

it("counts a disconnect once and puts arbitrary methods and URLs in one fixed bucket", () => {
  const timing = new ProcessTiming();
  for (let i = 0; i < 100; i++) {
    const res = new EventEmitter() as ServerResponse;
    trackRequest({ method: `UNKNOWN${i}`, url: `/private-${i}` } as IncomingMessage, res, timing);
    res.emit("close");
    res.emit("finish");
  }
  expect(timing.facts().routes).toMatchObject([
    { method: "OTHER", route: "<unmatched>", lifetime: { count: 100 } },
  ]);
});
