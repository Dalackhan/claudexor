import type { CliCommandSpec } from "./command-registry.js";
export const THREAD_HISTORY_COMMAND_SPECS: readonly CliCommandSpec[] = [
  {
    id: "thread",
    positionalPatterns: [
      { prefix: ["history"], min: 2, max: 2 },
      { prefix: ["prompt"], min: 3, max: 3 },
    ],
    usageArgs:
      "history <id> [--limit N] [--cursor C | --before ID | --after ID | --around ID] [--json]",
    summary:
      "Read bounded thread history with answers, or one complete-prompt part; never starts a daemon",
    flags: [
      "limit",
      "cursor",
      "before",
      "after",
      "around",
      "offset",
      "max-bytes",
      "expected-store-id",
      "json",
    ],
    subcommandFlags: {
      history: ["limit", "cursor", "before", "after", "around", "expected-store-id", "json"],
      prompt: ["offset", "max-bytes", "expected-store-id", "json"],
    },
    extraUsageLines: [
      {
        text: "claudexor thread prompt <id> <turn-id> [--offset N] [--max-bytes N] --json",
        help: "Read a UTF-8 prompt part (including runless refusals).",
      },
    ],
    mutability: "read",
    stability: "stable",
  },
];
