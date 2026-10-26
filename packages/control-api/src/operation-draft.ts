import type { ControlOperationDescriptor } from "@claudexor/schema";
import { OPERATION_SUMMARIES } from "./operation-summaries.js";

export type OperationDraft = Omit<
  ControlOperationDescriptor,
  | "id"
  | "applicability"
  | "idempotency"
  | "completion"
  | "errorSchema"
  | "summary"
  | "auth"
  | "parameters"
> &
  Partial<
    Pick<
      ControlOperationDescriptor,
      "applicability" | "idempotency" | "completion" | "summary" | "parameters"
    >
  >;

export function operationDescriptor(input: OperationDraft): ControlOperationDescriptor {
  // Resource-family classification (QA-054) follows the resource plane.
  // Collection/create routes inherit their family without an instance id:
  // GET/POST /v2/projects are project-applicable, just as runs/threads are.
  // A missing collection branch would falsely report global applicability.
  const applicability =
    input.path.includes("/threads/") || input.path === "/v2/threads"
      ? "thread"
      : input.path.includes("/runs/") || input.path === "/v2/runs"
        ? "run"
        : input.path.includes("/projects/") || input.path === "/v2/projects"
          ? "project"
          : "global";
  const key = `${input.method} ${input.path}`;
  const summary = input.summary ?? OPERATION_SUMMARIES[key];
  if (!summary) {
    // Fail loudly at construction: a new route without a human summary can
    // never ship a blank descriptor (INV-122 SSOT — no silent gaps).
    throw new Error(`operation catalog: missing summary for '${key}'`);
  }
  return {
    ...input,
    summary,
    // Every product route is loopback + bearer; the loopback-only health probe
    // is unversioned and never enters this catalog.
    auth: "loopback_bearer",
    errorSchema: "ControlProblem",
    id: `${input.method.toLowerCase()}:${input.path.slice(4).replaceAll(/[:/<>]+/g, ".")}`,
    applicability: input.applicability ?? applicability,
    parameters: input.parameters ?? [],
    idempotency: input.idempotency ?? (input.mutability === "read_only" ? "natural" : "none"),
    completion:
      input.completion ?? (input.responseKind === "stream" ? "terminal_stream" : "immediate"),
  };
}
