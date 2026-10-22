import type { McpTool, RunnerFn } from "./index.js";
import { runWaitTool } from "./run-wait-tool.js";
import { runEventReadTool } from "./run-event-read-tool.js";
import { runsWaitTool } from "./runs-wait-tool.js";

export function runObservationTools(runner: RunnerFn): McpTool[] {
  return [runWaitTool(runner), runEventReadTool(runner), runsWaitTool(runner)];
}
