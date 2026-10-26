import type { CliCommandSpec } from "./command-registry.js";

export const UPLOAD_COMMAND_SPECS: readonly CliCommandSpec[] = [
  {
    id: "upload-create",
    usageArgs: "--request-json '<object>' --idempotency-key <key> --json",
    positionalPatterns: [{ min: 0, max: 0 }],
    summary: "Create an ordinary attachment upload; save its caller-owned key/body",
    flags: ["request-json", "idempotency-key", "json"],
    mutability: "write",
    stability: "stable",
  },
  {
    id: "upload-import-local",
    usageArgs: "<upload_id> <absolute-host-file> --json",
    positionalPatterns: [{ min: 2, max: 2 }],
    summary: "Stream one explicit file on this host into an upload; return its digest/status",
    flags: ["json"],
    mutability: "write",
    stability: "stable",
  },
  {
    id: "upload-status",
    usageArgs: "<upload_id> --json",
    positionalPatterns: [{ min: 1, max: 1 }],
    summary: "Read upload state once; finalized absence does not replace finalize replay",
    flags: ["json"],
    mutability: "read",
    stability: "stable",
  },
  {
    id: "upload-finalize",
    usageArgs: "<upload_id> --request-json '<object>' --idempotency-key <key> --json",
    positionalPatterns: [{ min: 1, max: 1 }],
    summary: "Finalize immutable attachment bytes; replay the original key/body after uncertainty",
    flags: ["request-json", "idempotency-key", "json"],
    mutability: "write",
    stability: "stable",
  },
  {
    id: "upload-cancel",
    usageArgs: "<upload_id> --json",
    positionalPatterns: [{ min: 1, max: 1 }],
    summary: "Explicitly cancel an unfinished upload",
    flags: ["json"],
    mutability: "write",
    stability: "stable",
  },
];
