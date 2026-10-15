// Combined exact-output buffer policy: 256 MiB, below V8's ~512 MiB string
// limit. Conversion and child memory are additional; this is not an RSS bound.
export const CAPTURE_BUFFER_BUDGET_BYTES = 256 * 1024 * 1024;
type Stream = "stdout" | "stderr";

export class CaptureOutputExceeded extends Error {
  readonly code = "capture_output_exceeded";
  constructor(
    readonly stream: Stream,
    readonly bufferBudgetBytes = CAPTURE_BUFFER_BUDGET_BYTES,
  ) {
    super(`${stream} exceeded the ${bufferBudgetBytes}-byte combined capture buffer budget`);
    this.name = "CaptureOutputExceeded";
  }
}

/** Owns all exact-capture buffers; an overflow releases both streams at once. */
export class CaptureBuffers {
  private chunks: Record<Stream, Buffer[]> = { stdout: [], stderr: [] };
  private bytes = 0;
  constructor(private readonly budget = CAPTURE_BUFFER_BUDGET_BYTES) {}
  get bufferedBytes(): number {
    return this.bytes;
  }

  append(stream: Stream, chunk: Buffer): void {
    if (chunk.length > this.budget - this.bytes) {
      this.clear();
      throw new CaptureOutputExceeded(stream, this.budget);
    }
    this.bytes += chunk.length;
    this.chunks[stream].push(chunk);
  }

  text(stream: Stream): string {
    return Buffer.concat(this.chunks[stream]).toString("utf8");
  }

  clear(): void {
    this.chunks.stdout.length = this.chunks.stderr.length = 0;
    this.bytes = 0;
  }
}

/** Exact consumers must refuse a line capture whose lifecycle owner closed a pipe. */
export function assertCaptureComplete(result: { code: number | null; drain?: "truncated" }): void {
  if (result.drain === "truncated") {
    throw Object.assign(new Error("Process output was not completely drained"), {
      code: "capture_output_incomplete",
      drain: result.drain,
    });
  }
}
