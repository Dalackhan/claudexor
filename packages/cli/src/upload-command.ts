import { flagStr, requiredStringFlagError, type ParsedArgs } from "./args.js";
import { printJson } from "./cli-io.js";
import { renderCliFailure, usageError } from "./cli-error.js";
import { uploadQuery } from "./upload-query.js";

/** Terminal spelling of the same finite MCP/HTTP controls. */
export async function uploadCommand(args: ParsedArgs, json: boolean): Promise<number> {
  try {
    const error = requiredStringFlagError(args, ["request-json", "idempotency-key"]);
    if (error) throw usageError(error, { code: "invalid_argument" });
    const action = args._[0]?.slice("upload-".length).replaceAll("-", "_") ?? "";
    const rawRequest = flagStr(args, "request-json");
    let request: unknown;
    if (rawRequest !== undefined) {
      try {
        request = JSON.parse(rawRequest);
      } catch {
        throw usageError("--request-json must contain a JSON object", { code: "invalid_argument" });
      }
    }
    const input = {
      ...(action !== "create" ? { uploadId: args._[1] } : {}),
      ...(action === "import_local" ? { path: args._[2] } : {}),
      ...(request !== undefined ? { request } : {}),
      ...(flagStr(args, "idempotency-key") !== undefined
        ? { idempotencyKey: flagStr(args, "idempotency-key") }
        : {}),
    };
    printJson(await uploadQuery(action, input));
    return 0;
  } catch (error) {
    return renderCliFailure(json, error, { messagePrefix: "claudexor upload:" });
  }
}
