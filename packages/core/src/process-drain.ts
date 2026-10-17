/**
 * The bounded post-exit output drain (#449 item 2). The direct child may exit
 * while a descendant keeps our stdout/stderr pipe open, so `close` — which
 * finishes capture — would never fire and the run would hang on its terminal
 * barrier. After exit, the OS pipe is read until it is QUIET for `exitDrainMs`
 * (raw bytes, so a frame the consumer has not accepted yet still counts as
 * progress, and time the bounded reader spends blocked on consumer capacity
 * is never idle) or an ABSOLUTE post-exit bound passes that a chatty
 * descendant cannot renew. Then the reader is told to STOP (not to discard)
 * and our side of the pipes is ended — frames already read are kept — and the
 * exit event says `drain: "truncated"`. The run-end reap ends the leftover.
 */
import type { ChildProcess } from "node:child_process";

export interface PostExitDrainOptions {
  exitDrainMs: number;
  exitDrainMaxMs: number;
  /** The bounded line reader is waiting for consumer capacity (never idle). */
  readerBlocked: () => boolean;
  /** Tell the line reader to stop reading without discarding what it read. */
  stopReader: () => void;
}

export interface PostExitDrain {
  /** Arm on the direct child's `exit` (idempotent). */
  arm(): void;
  /** Disarm on `close`/`error`/consumer break. */
  clear(): void;
  /** The bound forced the closure (reported as `drain: "truncated"`). */
  readonly truncated: boolean;
}

export function postExitDrain(child: ChildProcess, options: PostExitDrainOptions): PostExitDrain {
  const { exitDrainMs, exitDrainMaxMs } = options;
  const rawBytesRead = (): number =>
    ((child.stdout as unknown as { bytesRead?: number } | null)?.bytesRead ?? 0) +
    ((child.stderr as unknown as { bytesRead?: number } | null)?.bytesRead ?? 0);
  let drainTruncated = false;
  let drainTimer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    if (exitDrainMs <= 0 || drainTimer) return;
    const exitedAt = Date.now();
    let progressBytes = rawBytesRead();
    let progressAt = exitedAt;
    drainTimer = setInterval(
      () => {
        const now = Date.now();
        const read = rawBytesRead();
        if (read !== progressBytes) {
          progressBytes = read;
          progressAt = now;
        }
        // Blocked on consumer capacity: the reader is not idle, it is waiting
        // for the consumer; the absolute bound still applies.
        if (options.readerBlocked()) progressAt = now;
        const quiet = now - progressAt >= exitDrainMs;
        const overdue = now - exitedAt >= exitDrainMaxMs;
        if (!quiet && !overdue) return;
        drainTruncated = true;
        if (drainTimer) clearInterval(drainTimer);
        drainTimer = undefined;
        // Tell the line reader to STOP reading (not to discard): every frame
        // it already assembled — including one waiting for consumer capacity —
        // and its stderr tail are still delivered, and the premature-close
        // rejection that follows is the expected end of input. Then end our
        // side of the pipes so `close` fires. The leftover keeps its own fd.
        options.stopReader();
        child.stdout?.destroy();
        child.stderr?.destroy();
      },
      Math.max(50, Math.min(exitDrainMs, 500)),
    );
    drainTimer.unref?.();
  };
  return {
    arm,
    clear: () => {
      if (drainTimer) clearInterval(drainTimer);
      drainTimer = undefined;
    },
    get truncated() {
      return drainTruncated;
    },
  };
}
