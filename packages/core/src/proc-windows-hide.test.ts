import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// A pass-through spy over the REAL spawn: the recorded options prove the window
// policy on every platform, while each child still runs for real, so the
// Windows CI leg consumes the hidden-window spawn instead of a fake.
const spawnSpy = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  spawnSpy.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnSpy };
});

import { runCaptureRaw, spawnProcess } from "./proc.js";
import { windowsQuietChildrenPreload } from "./npm-launch.js";

// The hidden window is added to, never traded for, the existing background
// spawn shape: piped stdio in its own process group.
const BACKGROUND_SPAWN = {
  windowsHide: true,
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
};

describe("background process window policy", () => {
  it("hides the console window for streamed child processes", async () => {
    const stdout: string[] = [];
    let exitCode: number | null | undefined;
    for await (const ev of spawnProcess(process.execPath, ["-e", "console.log('probe-ok')"])) {
      if (ev.type === "stdout") stdout.push(ev.line);
      if (ev.type === "exit") exitCode = ev.code;
    }

    expect(stdout).toEqual(["probe-ok"]);
    expect(exitCode).toBe(0);
    expect(spawnSpy).toHaveBeenCalledOnce();
    expect(spawnSpy.mock.calls[0]?.[2]).toMatchObject(BACKGROUND_SPAWN);
  });

  it("hides the console window for raw capture child processes", async () => {
    const result = await runCaptureRaw(process.execPath, [
      "-e",
      "process.stdout.write('a\\r\\nb')",
    ]);

    expect(result).toMatchObject({ code: 0, signal: null, stdout: "a\r\nb" });
    expect(spawnSpy).toHaveBeenCalledOnce();
    expect(spawnSpy.mock.calls[0]?.[2]).toMatchObject(BACKGROUND_SPAWN);
  });
});

// Recorded npm cmd-shim bytes select a copied node.exe for a vendor script
// whose native console child inherits stdio, as Codex's wrapper does.
describe.skipIf(process.platform !== "win32")("Windows npm wrapper children", () => {
  it.each(["raw", "stream"])(
    "the %s background consumer preloads quiet defaults for a wrapper's native child",
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), "quiet-wrapper-"));
      try {
        const packageRoot = join(root, "node_modules", "@fixture", "tool");
        const script = join(packageRoot, "bin", "tool.cjs");
        mkdirSync(dirname(script), { recursive: true });
        writeFileSync(
          script,
          `#!/usr/bin/env node
          const {spawnSync} = require("node:child_process");
          const result = spawnSync(process.execPath, ["-e", "console.log(process.env.MARKER)"],
            {stdio: "inherit", env: process.env});
          process.exit(result.status ?? 1);`,
        );
        writeFileSync(
          join(packageRoot, "package.json"),
          JSON.stringify({ name: "@fixture/tool", bin: { tool: "bin/tool.cjs" } }),
        );
        const shim = join(root, "tool.cmd");
        const recorded = new URL("./fixtures/npm-launch/node.cmd", import.meta.url);
        writeFileSync(shim, readFileSync(recorded, "utf8").replace(/\r?\n/g, "\r\n"));
        copyFileSync(process.execPath, join(root, "node.exe"));
        // NODE_OPTIONS preloads run before the command-line preload, so this
        // records what reaches Node's own spawnSync inside the wrapper.
        const recorder = join(root, "recorder.cjs");
        const record = join(root, "record.jsonl");
        writeFileSync(
          recorder,
          `const cp = require("node:child_process");
          const original = cp.spawnSync;
          cp.spawnSync = function (file, args, options) {
            require("node:fs").appendFileSync(process.env.RECORD,
              JSON.stringify({args, windowsHide: options.windowsHide, stdio: options.stdio}) + "\\n");
            return Reflect.apply(original, this, arguments);
          };`,
        );
        const env = {
          PATH: root,
          MARKER: "grandchild-reached",
          RECORD: record,
          NODE_OPTIONS: `--require "${recorder.replace(/\\/g, "/")}"`,
        };
        const opts = { env, timeoutMs: 15_000 };
        if (mode === "raw") {
          const result = await runCaptureRaw(shim, [], opts);
          expect(result.code, result.stderr).toBe(0);
          expect(result.stdout.trim()).toBe("grandchild-reached");
        } else {
          const events = [];
          for await (const event of spawnProcess(shim, [], opts)) events.push(event);
          expect(events).toContainEqual(
            expect.objectContaining({ type: "stdout", line: "grandchild-reached" }),
          );
          expect(events.at(-1)).toMatchObject({ type: "exit", code: 0 });
        }
        expect(spawnSpy.mock.calls[0]?.[1]).toEqual([
          "--require",
          windowsQuietChildrenPreload(),
          script,
        ]);
        expect(spawnSpy.mock.calls[0]?.[2]).toMatchObject(BACKGROUND_SPAWN);
        expect(
          readFileSync(record, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual([
          {
            args: ["-e", "console.log(process.env.MARKER)"],
            windowsHide: true,
            stdio: "inherit",
          },
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
