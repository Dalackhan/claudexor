import type { HarnessEvent } from "@claudexor/schema";

/** The vendor's headless diagnostic, observed independently of model stdout.
 * Keep only the native permission fact, before the diagnostic tail can evict it.
 * Generic empty output and permission-looking model prose are not evidence. */
export function createAgyNativeCompletion() {
  let permission: string | undefined;
  const observeStderr = (line: string): void => {
    permission ??=
      /^jetski: no output produced — a tool required the "([a-z_]+)" permission that headless mode cannot prompt for, so it was auto-denied\./m.exec(
        line,
      )?.[1];
  };
  async function* wrap(stream: AsyncIterable<HarnessEvent>): AsyncGenerator<HarnessEvent> {
    let hasAnswer = false;
    for await (const event of stream) {
      if (event.type === "message" && event.final === true && event.text?.trim()) hasAnswer = true;
      if (event.type === "completed") {
        // Retained normalized recordings can replay the historical diagnostic.
        const tail = event.payload?.["stderr_tail"];
        if (typeof tail === "string") observeStderr(tail);
        if (permission)
          yield {
            type: hasAnswer ? "status" : "error",
            session_id: event.session_id,
            ts: event.ts,
            ...(hasAnswer
              ? {
                  text: `agy headless tool permission refused: ${permission}; retained answer is not proof of that tool's success`,
                }
              : { error: `agy headless tool permission refused: ${permission}` }),
            permission_denial: { permission, source: "agy_native_stderr" },
            payload: { code: "permission_denied" },
          };
      }
      yield event;
    }
  }
  return { observeStderr, wrap };
}
