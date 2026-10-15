import { afterEach, expect, it, vi } from "vitest";
import { CaptureBuffers } from "./capture-buffer.js";
import { CAPTURE_BUFFER_BUDGET_BYTES, CaptureOutputExceeded, runCaptureRaw } from "./proc.js";

afterEach(() => vi.restoreAllMocks());

it.each(["stdout", "stderr"] as const)(
  "drops both buffers when %s exceeds the combined capture budget",
  (stream) => {
    const buffers = new CaptureBuffers(8);
    buffers.append("stdout", Buffer.alloc(5));
    buffers.append("stderr", Buffer.alloc(3));
    expect(buffers.bufferedBytes).toBe(8);
    expect(() => buffers.append(stream, Buffer.from("x"))).toThrow(CaptureOutputExceeded);
    expect(buffers.bufferedBytes).toBe(0);
    expect(buffers.text("stdout")).toBe("");
    expect(buffers.text("stderr")).toBe("");
  },
);

it.each([1, 2] as const)(
  "refuses overflow on fd %s before concatenation and preserves the typed cause",
  async (fd) => {
    const concat = vi.spyOn(Buffer, "concat");
    vi.spyOn(CaptureBuffers.prototype, "append").mockImplementation((stream) => {
      throw new CaptureOutputExceeded(stream);
    });
    let error: unknown;
    try {
      await runCaptureRaw(process.execPath, [
        "-e",
        `
      const fs = require('node:fs');
      const block = Buffer.alloc(1024 * 1024, 65);
      let remaining = ${128 * 1024};
      while (remaining) {
        const count = Math.min(remaining, block.length);
        let offset = 0;
        while (offset < count) offset += fs.writeSync(${fd}, block, offset, count - offset);
        remaining -= count;
      }
    `,
      ]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CaptureOutputExceeded);
    expect(error).not.toBeInstanceOf(RangeError);
    expect(error).toMatchObject({
      stream: fd === 1 ? "stdout" : "stderr",
      bufferBudgetBytes: CAPTURE_BUFFER_BUDGET_BYTES,
    });
    expect(
      concat.mock.calls.filter(
        ([chunks]) => chunks.reduce((sum, chunk) => sum + chunk.length, 0) > 0,
      ),
    ).toEqual([]);
  },
);

it("preserves exact UTF-8/CRLF bytes, stderr, and the native exit code under budget", async () => {
  const result = await runCaptureRaw(process.execPath, [
    "-e",
    "require('node:fs').writeSync(1, 'a\\r\\n☺b'); require('node:fs').writeSync(2, 'error\\r\\n'); process.exit(7)",
  ]);
  expect(result).toEqual({ code: 7, signal: null, stdout: "a\r\n☺b", stderr: "error\r\n" });
});
