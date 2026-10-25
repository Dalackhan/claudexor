import type { HarnessEvent, ToolRef } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";

type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const string = (value: unknown): string => (typeof value === "string" ? value : "");

/** Only vendor failure channels call this classifier; assistant prose never does. */
export function grokFailure(value: unknown, sessionId: string): HarnessEvent {
  const data = object(value);
  const message = string(value) || string(data.message) || string(data.error) || "Grok CLI failed";
  const event: HarnessEvent = {
    type: "error",
    session_id: sessionId,
    ts: nowIso(),
    error: redactSecrets(message).slice(0, 2000),
  };
  const code = string(data.code) || string(data.type);
  if (
    data.status === 429 ||
    data.status_code === 429 ||
    /^(?:rate_limit_exceeded|quota_exceeded|usage_limit_exceeded|resource_exhausted)$/.test(code) ||
    /\brate[ _-]?limit(?:ed| exceeded)?\b|\btoo many requests\b|\bquota[ _-]?(?:exceeded|exhausted)\b|\busage limit\b|\b(?:HTTP|status|code)\s*429\b/i.test(
      message,
    )
  ) {
    const seconds = data.retry_after ?? data.retry_after_seconds;
    const delay =
      typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
        ? Math.ceil(seconds * 1000)
        : null;
    const resets =
      typeof data.resets_at === "string" && Number.isFinite(Date.parse(data.resets_at))
        ? new Date(data.resets_at).toISOString()
        : null;
    event.rate_limit = { resets_at: resets, retry_delay_ms: delay, applies_to_models: null };
    event.status = { kind: "api_retry", error_category: "rate_limit" };
  } else if (
    /auth|unauthorized|login_required/.test(code) ||
    /\b(?:unauthenticated|unauthorized|authentication required)\b/i.test(message)
  ) {
    event.status = { kind: "api_retry", error_category: "authentication_failed" };
  }
  return event;
}

/** Messages JSON is Claude-shaped, but usage/finality belong to Grok's result,
 * never to intermediate assistant messages or tool-result text. */
export function createGrokParser() {
  const tools = new Map<string, ToolRef>();
  let terminal = false;
  const parseEvent = (raw: unknown, sessionId: string): HarnessEvent[] | null => {
    const obj = object(raw);
    const base = { session_id: sessionId, ts: nowIso() };
    if (obj.type === "system") {
      if (obj.subtype !== "init") return [];
      return [
        {
          ...base,
          type: "started",
          observed_model: string(obj.model) || undefined,
          payload: { native_session_id: string(obj.session_id) },
        },
      ];
    }
    if (obj.type === "assistant") {
      const events: HarnessEvent[] = [];
      for (const block of Array.isArray(obj.message?.content) ? obj.message.content : []) {
        if (block.type === "text" && typeof block.text === "string")
          events.push({ ...base, type: "message", text: block.text });
        if (block.type === "tool_use" || block.type === "server_tool_use") {
          const name = string(block.name) || "tool";
          const input = object(block.input);
          const target =
            string(input.file_path) ||
            string(input.path) ||
            string(input.relative_workspace_path) ||
            string(input.command);
          const tool: ToolRef = {
            name,
            kind:
              name === "grep"
                ? "search"
                : /terminal|command/.test(name)
                  ? "command"
                  : /web_/.test(name)
                    ? "web"
                    : ["read_file", "list_dir", "search_replace", "write"].includes(name)
                      ? "file"
                      : "other",
            use_id: string(block.id) || undefined,
            target: target ? redactSecrets(target).slice(0, 500) : undefined,
          };
          if (tool.use_id) tools.set(tool.use_id, tool);
          events.push({ ...base, type: "tool_call", text: name, tool });
        }
      }
      return events;
    }
    if (obj.type === "user") {
      const events: HarnessEvent[] = [];
      for (const block of Array.isArray(obj.message?.content) ? obj.message.content : []) {
        if (block.type !== "tool_result") continue;
        const id = string(block.tool_use_id);
        const tool = tools.get(id) ?? { name: "tool", kind: "other" as const, use_id: id };
        if (typeof block.is_error !== "boolean") {
          events.push({
            ...base,
            type: "status",
            text: `${tool.name}: result carried no success or failure status`,
            tool,
          });
          continue;
        }
        const detail = redactSecrets(string(block.content)).slice(0, 1000);
        events.push({
          ...base,
          type: "tool_result",
          text: "tool_result",
          tool: {
            ...tool,
            status: block.is_error === true ? "error" : "ok",
            ...(block.is_error === true
              ? { error_summary: detail || "tool failed" }
              : { content_summary: detail || undefined }),
          },
        });
        if (block.is_error !== true && ["search_replace", "write"].includes(tool.name))
          events.push({
            ...base,
            type: "file_change",
            tool,
            payload: { path: tool.target, tool: tool.name },
          });
        tools.delete(id);
      }
      return events;
    }
    if (obj.type === "error") {
      terminal = true;
      return [
        grokFailure(
          {
            ...obj,
            ...object(obj.error),
            message: string(obj.error) || string(object(obj.error).message) || string(obj.message),
          },
          sessionId,
        ),
      ];
    }
    if (obj.type === "result" || (obj.type === undefined && typeof obj.response === "string")) {
      if (terminal) return [];
      terminal = true;
      const events: HarnessEvent[] = [];
      if (obj.is_error === true || (obj.subtype && obj.subtype !== "success")) {
        const detail = Array.isArray(obj.errors)
          ? obj.errors.filter((v: unknown) => typeof v === "string").join("; ")
          : "";
        events.push(
          grokFailure(
            {
              ...obj,
              ...object(obj.error),
              message:
                detail ||
                string(obj.error) ||
                string(obj.result) ||
                `Grok terminal status ${obj.subtype}`,
            },
            sessionId,
          ),
        );
      } else {
        const text =
          obj.structured_output != null
            ? JSON.stringify(obj.structured_output)
            : string(obj.result) || string(obj.response);
        events.push(
          text.trim()
            ? { ...base, type: "message", text, final: true, payload: { final_source: "result" } }
            : grokFailure("Grok returned an empty final response", sessionId),
        );
      }
      const usage: NonNullable<HarnessEvent["usage"]> = {};
      const source = object(obj.usage);
      for (const [native, normalized] of [
        ["input_tokens", "input_tokens"],
        ["output_tokens", "output_tokens"],
        ["cache_read_input_tokens", "cached_input_tokens"],
      ] as const) {
        const n = source[native];
        if (typeof n === "number" && Number.isFinite(n) && n >= 0) usage[normalized] = n;
      }
      // OAuth cost is vendor accounting, not a charge to the user's API key.
      // Tokens remain useful without manufacturing a subscription price.
      if (Object.keys(usage).length) events.push({ ...base, type: "usage", usage });
      return events;
    }
    if (obj.type === "stream_event") return [];
    return null;
  };
  return { parseEvent, hasTerminal: () => terminal };
}
