import type { ParsedArgs } from "./args.js";
import { runsWaitCommand } from "./runs-wait-command.js";
import { taskGroupRunsCommand } from "./task-group-runs.js";
import { threadHistoryCommand } from "./thread-history.js";
export function dispatchObservationCommand(command: string, args: ParsedArgs, json: boolean) {
  if (command === "runs-wait") return runsWaitCommand(args, json);
  if (command === "task-group-runs") return taskGroupRunsCommand(args, json);
  if (command === "thread") return threadHistoryCommand(args, json);
  return null;
}
