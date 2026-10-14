import {
  spawnProcess,
  reapProcessTree,
  WINDOWS_TREE_DEATH_PROOF_UNAVAILABLE,
  type spawnProcess as SpawnProcess,
} from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { fileURLToPath } from "node:url";
import { spawn as spawnChild } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runCodexAppServer } from "./app-server-run.js";

const peer = fileURLToPath(new URL("../fixtures/app-server/cleanup-peer.mjs", import.meta.url));

async function nativeCodexEvents(
  text: string,
  cancel = false,
  wrapper = false,
  survivor?: number,
  lateError = false,
): Promise<HarnessEvent[]> {
  const abort = new AbortController();
  const pids = new Set<number>();
  const observed: HarnessEvent[] = [];
  let observedLateFrame = false;
  let releaseLateFrame!: () => void;
  const lateFrame = new Promise<void>((resolve) => {
    releaseLateFrame = resolve;
  });
  const spawn: typeof SpawnProcess = async function* (bin, args, options) {
    for await (const event of spawnProcess(bin, args, {
      ...options,
      ...(survivor === undefined && !lateError
        ? {}
        : {
            reap: async (opts) => {
              if (lateError) {
                // Test-only synchronization: Windows taskkill is synchronous and
                // otherwise wins before stdin EOF can produce the drained frame.
                // Real cleanup runs even if the bounded observation fails.
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                  await Promise.race([
                    lateFrame,
                    new Promise<void>((resolve) => {
                      timer = setTimeout(resolve, 5000);
                    }),
                  ]);
                } finally {
                  if (timer) clearTimeout(timer);
                }
              }
              const real = await reapProcessTree(opts);
              if (lateError) {
                if (real.state === "unconfirmed" && real.survivors.length) return real;
                return {
                  state: "unconfirmed",
                  survivors: [],
                  unresolved: [
                    { pgid: opts.rootPid, reason: WINDOWS_TREE_DEATH_PROOF_UNAVAILABLE },
                  ],
                };
              }
              process.kill(survivor!, 0); // positive OS observation of this fixture's retained child
              return { state: "unconfirmed" as const, survivors: [survivor!], unresolved: [] };
            },
          }),
    })) {
      if (event.type === "stderr" && event.line.startsWith("fixture-pid:"))
        pids.add(Number(event.line.slice(12)));
      yield event;
      if (lateError && event.type === "stdout" && event.line.includes('"systemError"')) {
        observedLateFrame = true;
        releaseLateFrame();
      }
    }
  };
  try {
    for await (const event of runCodexAppServer({
      bin: process.execPath,
      args: [
        peer,
        ...(wrapper ? ["--wrapper"] : []),
        ...(cancel ? ["--wait-for-cancel"] : []),
        ...(lateError ? ["--late-system-error"] : []),
      ],
      env: { CX_FIXTURE_ANSWER: text },
      spawn,
      pollIntervalMs: 0,
      spec: {
        ...HarnessRunSpec.parse({
          session_id: "native-cleanup",
          intent: "implement",
          prompt: "fixture",
          cwd: process.cwd(),
        }),
        extra: { abortSignal: abort.signal },
      },
    })) {
      observed.push(event);
      if (cancel && event.type === "started") abort.abort();
    }
    if (lateError)
      expect(observedLateFrame, "test-only late-frame synchronization reached").toBe(true);
    expect(pids.size).toBe(wrapper ? 2 : 1);
    for (const pid of pids)
      expect(() => process.kill(pid, 0), `fixture process ${pid} must be gone`).toThrow();
    return observed;
  } finally {
    // Only exact processes this fixture launched; no name matching or live daemon.
    abort.abort();
    for (const pid of pids) {
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        /* absent */
      }
      if (alive) await reapProcessTree({ rootPid: pid, deadlineMs: 5000 });
    }
  }
}

describe("native process Codex cleanup (no vendor credentials)", () => {
  it("rejects a native root error drained during normal shutdown", async () => {
    // Real peer, I/O and reaper; only the known Windows observer outcome is injected.
    const events = await nativeCodexEvents('{"verdict":"PASS"}', false, false, undefined, true);
    expect(events.some((e) => e.final)).toBe(false);
    expect(events.find((e) => e.type === "error")?.payload?.["code"]).toBe("codex_control_loss");
  }, 30000);
  it.each([false, true])(
    "preserves ordinary completion through wrapper=%s",
    async (wrapper) => {
      const text = '{"verdict":"FAIL","finding":"controlled fixture"}';
      const events = await nativeCodexEvents(text, false, wrapper);
      if (process.env["CX_CLEANUP_BASELINE"] === "1") {
        expect(process.platform).toBe("win32");
        expect(events.some((e) => e.final)).toBe(false);
        expect(events.find((e) => e.type === "error")?.payload?.["code"]).toBe(
          "codex_control_loss",
        );
        expect(events.at(-1)?.payload?.["termination_unconfirmed"]).toBeTruthy();
        return;
      }
      expect(events.filter((e) => e.final).map((e) => e.text)).toEqual([text]);
      expect(events.some((e) => e.type === "error")).toBe(false);
      if (process.platform === "win32")
        expect(events.at(-1)?.payload?.["termination_unconfirmed"]).toBeTruthy();
    },
    30000,
  );
  it("does not turn an externally cancelled native process into a usable answer", async () => {
    const events = await nativeCodexEvents("partial", true);
    expect(events.some((e) => e.final)).toBe(false);
    expect(events.at(-1)?.aborted).toBe(true);
  }, 30000);
  it("rejects an observed live survivor through the controlled reap seam", async () => {
    // The survivor is real, but intentionally outside the peer tree. Only the
    // reap outcome is injected; this is not a claim that taskkill failed.
    const child = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const events = await nativeCodexEvents(
        "complete but cleanup failed",
        false,
        false,
        child.pid,
      );
      expect(events.some((e) => e.final)).toBe(false);
      expect(events.find((e) => e.type === "error")?.payload?.["code"]).toBe("codex_control_loss");
      expect(events.at(-1)?.payload?.["termination_unconfirmed"]).toMatchObject({
        survivors: [child.pid],
      });
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  }, 30000);
});
