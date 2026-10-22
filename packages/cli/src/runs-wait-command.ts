import { RunWaitManyInput } from "@claudexor/schema";
import { flagBool, flagStr, requiredStringFlagError, type ParsedArgs } from "./args.js";
import { renderCliFailure, usageError } from "./cli-error.js";
import { printJson, printJsonLine } from "./cli-io.js";
import { runsWaitQuery } from "./mcp-runs-wait.js";

/** A single compact observation, including in JSON-stream mode. */
export async function runsWaitCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const stream = flagBool(args, "json-stream");
  try {
    const flagError = requiredStringFlagError(args, ["targets-json", "wait-ms"]);
    if (flagError) throw usageError(flagError, { code: "invalid_argument" });
    const raw = flagStr(args, "targets-json");
    if (!raw)
      throw usageError(
        "usage: claudexor runs-wait --targets-json '<array>' [--wait-ms <ms>] --json",
        {
          code: "invalid_argument",
        },
      );
    let targets: unknown;
    try {
      targets = JSON.parse(raw);
    } catch {
      throw usageError("--targets-json must be a JSON array of target objects", {
        code: "invalid_argument",
      });
    }
    const wait = flagStr(args, "wait-ms");
    const input = RunWaitManyInput.parse({
      targets,
      ...(wait === undefined ? {} : { waitMs: Number(wait) }),
    });
    const result = await runsWaitQuery({
      targets: input.targets,
      ...(wait === undefined ? {} : { waitMs: input.waitMs }),
    });
    if (stream) printJsonLine(result);
    else printJson(result);
    return 0;
  } catch (error) {
    return renderCliFailure(json || stream, error, {
      stream,
      messagePrefix: "claudexor runs-wait:",
    });
  }
}
