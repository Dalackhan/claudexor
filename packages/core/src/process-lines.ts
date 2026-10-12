import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { ProcEvent } from "./proc.js";

/** Opt-in bounds for an NDJSON protocol. Existing CLI line readers are unchanged. */
export interface ProcessStreamLimits {
  stdoutFrameBytes: number;
  queuedFrames: number;
  stderrBytes: number;
}

export function readProcessLines(
  child: ChildProcessWithoutNullStreams,
  publish: (event: ProcEvent) => void,
  waitForSpace: () => Promise<void>,
  fail: (error: Error) => void,
  limits?: ProcessStreamLimits,
): { drained: Promise<void>; close(): void; stop(): void } {
  if (!limits) {
    const out = createInterface({ input: child.stdout });
    const err = createInterface({ input: child.stderr });
    out.on("line", (line) => publish({ type: "stdout", line }));
    err.on("line", (line) => publish({ type: "stderr", line }));
    const close = (): void => {
      out.close();
      err.close();
    };
    // readline publishes every complete line as it arrives, so stopping the
    // OS reads keeps everything already read; only a partial line is dropped.
    return { drained: Promise.resolve(), close, stop: close };
  }
  // `closed`: the consumer is gone — discard everything (early break).
  // `stopped`: the OS reads are being ended by the post-exit drain — deliver
  // every COMPLETE frame already assembled (including one waiting for consumer
  // capacity) and the retained stderr tail, then finish; the premature-close
  // rejection that follows is the expected end of input, never a failure.
  let closed = false;
  let stopped = false;
  const stdout = async () => {
    let parts: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of child.stdout) {
        const buffer = chunk as Buffer;
        let start = 0;
        while (start < buffer.length && !closed) {
          const lf = buffer.indexOf(10, start);
          const end = lf === -1 ? buffer.length : lf + 1;
          const part = buffer.subarray(start, end);
          bytes += part.length;
          if (bytes > limits.stdoutFrameBytes) throw new Error("stdout frame exceeds byte limit");
          parts.push(part);
          if (lf !== -1) {
            await waitForSpace();
            if (closed) return;
            const wire = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              Buffer.concat(parts, bytes),
            );
            publish({ type: "stdout", line: wire.slice(0, -1), wire });
            parts = [];
            bytes = 0;
          }
          start = end;
        }
        if (closed) return;
      }
    } catch (error) {
      if (!stopped) throw error;
      return; // forced end of input: what was complete has been published
    }
    if (bytes && !closed && !stopped) throw new Error("stdout ended with a truncated frame");
  };
  const stderr = async () => {
    let tail = Buffer.alloc(0);
    try {
      for await (const chunk of child.stderr) {
        if (closed) return;
        tail = Buffer.concat([tail, (chunk as Buffer).subarray(-limits.stderrBytes)]).subarray(
          -limits.stderrBytes,
        );
      }
    } catch (error) {
      if (!stopped) throw error;
    }
    if (tail.length && !closed) publish({ type: "stderr", line: tail.toString("utf8") });
  };
  const guarded = (read: () => Promise<void>) =>
    read().catch((error: unknown) => {
      if (!closed && !stopped) fail(error instanceof Error ? error : new Error(String(error)));
    });
  const drained = Promise.all([guarded(stdout), guarded(stderr)]).then(() => {});
  return {
    drained,
    close: () => {
      closed = true;
    },
    stop: () => {
      stopped = true;
    },
  };
}
