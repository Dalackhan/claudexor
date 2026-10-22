import type { CliCommandSpec } from "./command-registry.js";

export const RUN_OBSERVATION_COMMAND_SPECS: readonly CliCommandSpec[] = [
  {
    id: "runs-wait",
    positionalPatterns: [{ min: 0, max: 0 }],
    usageArgs: "--targets-json '<array>' [--wait-ms <ms>] [--json | --json-stream]",
    summary: "Observe attention from 1..1000 existing jobs/runs once; never starts a daemon",
    flags: ["targets-json", "wait-ms", "json", "json-stream"],
    mutability: "read",
    stability: "stable",
  },
];
