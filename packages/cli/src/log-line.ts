import { appendFileSync } from "node:fs";
import { safeProblemMessage } from "@claudexor/util";

/** One timestamped, redacted line in the daemon log; never throws. */
export const logLine = (path: string, message: string): void => {
  try {
    appendFileSync(path, `[${new Date().toISOString()}] ${safeProblemMessage(message)}\n`);
  } catch {
    /* lifecycle safety must not depend on diagnostic I/O */
  }
};
