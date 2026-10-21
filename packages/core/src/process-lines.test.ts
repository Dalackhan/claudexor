import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { spawnProcess } from "./proc.js";
import { readProcessLines } from "./process-lines.js";

const limits = { stdoutFrameBytes: 64, queuedFrames: 2, stderrBytes: 16 };
const capture = async (source: string) => {
  const events = [];
  for await (const event of spawnProcess(process.execPath, ["-e", source], {
    streamLimits: limits,
  }))
    events.push(event);
  return events;
};
describe("bounded process frames", () => {
  it("does not silently strip a UTF-8 BOM from transcript bytes", async () => {
    const events = await capture('process.stdout.write("\\uFEFF{}\\n")');
    expect(events.find((e) => e.type === "stdout")).toMatchObject({ wire: "\uFEFF{}\n" });
  });
  it("preserves CRLF and drains a bounded stderr tail", async () => {
    const events = await capture(
      'process.stdout.write("{}\\r\\n"); process.stderr.write("x".repeat(100)+"tail")',
    );
    expect(events.find((e) => e.type === "stdout")).toMatchObject({ line: "{}\r", wire: "{}\r\n" });
    expect(events.find((e) => e.type === "stderr")).toMatchObject({ line: "xxxxxxxxxxxxtail" });
  });
  it.each([
    ['process.stdout.write("x".repeat(65))', "exceeds byte limit"],
    ['process.stdout.write("{}")', "truncated frame"],
    ["process.stdout.write(Buffer.from([255,10]))", "not valid"],
  ])("rejects invalid framing: %s", async (source, error) => {
    await expect(capture(source)).rejects.toThrow(error);
  });
  describe("after the post-exit drain stopped the reader", () => {
    // The root writes its frames, leaves a descendant holding stdout and exits;
    // the consumer pauses after the first frame, so the reader is blocked on
    // capacity when the absolute drain cap (300 ms) stops it. Only the expected
    // end of input may be suppressed after that; a frame that breaks the
    // bounded protocol is still a failure.
    const held = (writes: string): string =>
      [
        "const {spawn}=require('node:child_process')",
        writes,
        "setTimeout(()=>{spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:['ignore',1,'ignore']});setTimeout(()=>process.exit(0),20)},150)",
      ].join(";");
    const drain = async (source: string, frameBytes = 65_536) => {
      const lines: string[] = [];
      let drained: string | undefined;
      let threw: unknown = null;
      let paused = false;
      try {
        for await (const event of spawnProcess(process.execPath, ["-e", source], {
          exitDrainMs: 100,
          exitDrainMaxMs: 300,
          streamLimits: { stdoutFrameBytes: frameBytes, queuedFrames: 1, stderrBytes: 4096 },
        })) {
          if (event.type === "stdout") lines.push(event.line);
          if (event.type === "exit") drained = event.drain;
          if (event.type === "stdout" && !paused) {
            paused = true;
            await new Promise((resolve) => setTimeout(resolve, 700));
          }
        }
      } catch (error) {
        threw = error;
      }
      return { lines, drained, threw };
    };
    const frames = '\'{"i":1}\\n{"i":2}\\n{"i":3}\\n\'';

    it("still rejects invalid UTF-8 decoded when the stopped reader resumes", async () => {
      const result = await drain(
        held(`process.stdout.write(Buffer.concat([Buffer.from(${frames}),Buffer.from([255,10])]))`),
      );
      expect(result.lines.slice(0, 3)).toEqual(['{"i":1}', '{"i":2}', '{"i":3}']);
      expect(String(result.threw)).toMatch(/not valid/);
    }, 15_000);

    it("still rejects an oversized frame taken from the stream's buffer at the stop", async () => {
      const result = await drain(
        held(
          `process.stdout.write(${frames});setTimeout(()=>process.stdout.write("x".repeat(2000)+"\\n"),60)`,
        ),
        1024,
      );
      expect(result.lines).toEqual(['{"i":1}', '{"i":2}', '{"i":3}']);
      expect(String(result.threw)).toMatch(/exceeds byte limit/);
    }, 15_000);

    it("delivers every valid frame and ends without an error (control)", async () => {
      const result = await drain(held(`process.stdout.write(${frames})`));
      expect(result.lines).toEqual(['{"i":1}', '{"i":2}', '{"i":3}']);
      expect(result.drained).toBe("truncated");
      expect(result.threw).toBeNull();
    }, 15_000);
  });

  describe("a stopped reader suppresses only the premature close of its destroyed streams", () => {
    // The drain calls stop() and then destroy() without an error, so the stream
    // iterators reject with ERR_STREAM_PREMATURE_CLOSE: the expected end of input.
    // Any other error after the stop is still a failure.
    const reader = () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const published: string[] = [];
      const failures: string[] = [];
      let blocked: (() => void) | null = null;
      let block = false;
      let publishError: Error | null = null;
      const lines = readProcessLines(
        { stdout, stderr } as unknown as ChildProcessWithoutNullStreams,
        (event) => {
          if (publishError) throw publishError;
          if (event.type === "stdout") published.push(event.line);
        },
        async () => {
          if (block) await new Promise<void>((resolve) => (blocked = resolve));
        },
        (error) => failures.push((error as NodeJS.ErrnoException).code ?? error.message),
        { stdoutFrameBytes: 1024, queuedFrames: 1, stderrBytes: 64 },
      );
      const settle = async (): Promise<void> => {
        block = false;
        blocked?.();
        await lines.drained;
      };
      const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
      const eio = () => Object.assign(new Error("read EIO"), { code: "EIO" });
      return {
        stdout,
        stderr,
        lines,
        published,
        failures,
        settle,
        tick,
        eio,
        blockNext: () => (block = true),
        failPublish: (error: Error) => (publishError = error),
      };
    };

    it("suppresses the drain's own closure (control)", async () => {
      const r = reader();
      r.stdout.write("a\n");
      await r.tick();
      r.lines.stop();
      r.stdout.destroy();
      r.stderr.destroy();
      await r.settle();
      expect(r.published).toEqual(["a"]);
      expect(r.failures).toEqual([]);
    });

    it("still fails on a stdout I/O error that surfaces after the stop", async () => {
      const r = reader();
      r.blockNext();
      r.stdout.write("a\n");
      await r.tick();
      r.stdout.destroy(r.eio()); // reported while the reader waits for capacity
      await r.tick();
      r.lines.stop();
      r.stderr.destroy();
      await r.settle();
      expect(r.published).toEqual(["a"]);
      expect(r.failures).toEqual(["EIO"]);
    });

    it("still fails on a stderr I/O error after the stop", async () => {
      const r = reader();
      r.lines.stop();
      r.stdout.destroy();
      r.stderr.destroy(r.eio());
      await r.settle();
      expect(r.failures).toEqual(["EIO"]);
    });

    it("still fails when a consumer callback fails after the stop", async () => {
      const r = reader();
      r.blockNext();
      r.stdout.write("a\n");
      await r.tick();
      r.lines.stop();
      r.failPublish(Object.assign(new Error("publish failed"), { code: "CALLBACK" }));
      r.stdout.destroy();
      r.stderr.destroy();
      await r.settle();
      expect(r.failures).toEqual(["CALLBACK"]);
    });

    it("still fails on an invalid frame decoded after the stop (control)", async () => {
      const r = reader();
      r.blockNext();
      r.stdout.write(Buffer.from([0xff, 0x0a]));
      await r.tick();
      r.lines.stop();
      r.stdout.destroy();
      r.stderr.destroy();
      await r.settle();
      expect(r.failures).toEqual(["ERR_ENCODING_INVALID_ENCODED_DATA"]);
    });
  });

  it("backpressures a burst without losing frames", async () => {
    const iterator = spawnProcess(
      process.execPath,
      ["-e", 'for(let i=0;i<200;i++) process.stdout.write(i+"\\n")'],
      { streamLimits: limits },
    );
    const lines = [];
    for await (const event of iterator) {
      if (event.type === "stdout") lines.push(event.line);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(lines).toEqual(Array.from({ length: 200 }, (_, i) => String(i)));
  });
});

describe("LF-only stdout framing", () => {
  it("keeps Unicode separators and fragmented UTF-8 inside JSON payloads", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const lines: string[] = [];
    const reader = readProcessLines(
      { stdout, stderr } as unknown as ChildProcessWithoutNullStreams,
      (event) => {
        if (event.type === "stdout") lines.push(event.line);
      },
      async () => {},
      (error) => {
        throw error;
      },
      undefined,
      "lf",
    );
    const payload = { text: "до\u2028середина\u2029после 😀".repeat(2000) };
    const wire = Buffer.from(
      JSON.stringify(payload) + "\r\n" + JSON.stringify({ end: true }) + "\n",
    );
    for (let i = 0; i < wire.length; i += 7) stdout.write(wire.subarray(i, i + 7));
    stdout.end();
    stderr.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    reader.close();
    expect(lines.map((line) => JSON.parse(line))).toEqual([payload, { end: true }]);
  });

  it("drops an incomplete frame when capture is stopped", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const lines: string[] = [];
    const reader = readProcessLines(
      { stdout, stderr } as unknown as ChildProcessWithoutNullStreams,
      (event) => {
        if (event.type === "stdout") lines.push(event.line);
      },
      async () => {},
      (error) => {
        throw error;
      },
      undefined,
      "lf",
    );
    stdout.write('{"complete":true}\n{"partial":');
    reader.stop();
    stdout.end("true}\n");
    stderr.end();
    expect(lines).toEqual(['{"complete":true}']);
  });
});
