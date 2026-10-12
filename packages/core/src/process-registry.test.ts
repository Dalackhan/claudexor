import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { spawnProcess } from "./proc.js";
import {
  liveChildProcesses,
  registerChildProcess,
  unregisterChildProcess,
} from "./process-registry.js";
import { mintRunScopeMarker } from "./process-scope.js";

describe("process registry scope marker", () => {
  it.runIf(process.platform !== "win32")(
    "records the marker NAME a group-leader child was registered under, and nothing without one",
    async () => {
      const marker = mintRunScopeMarker();
      // Only a process-group LEADER registers (its kernel identity is captured);
      // a detached child is one, the vitest worker itself is not.
      const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"], {
        detached: true,
        stdio: "ignore",
      });
      const pid = child.pid!;
      try {
        registerChildProcess(pid, "leader", marker);
        expect(liveChildProcesses().find((c) => c.pid === pid)?.scopeMarker).toBe(marker);
        registerChildProcess(pid, "leader");
        expect(liveChildProcesses().find((c) => c.pid === pid)?.scopeMarker).toBeUndefined();
      } finally {
        unregisterChildProcess(pid);
        child.kill("SIGKILL");
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "a spawned harness child is registered under the run marker found in its env, then unregistered on close",
    async () => {
      const marker = mintRunScopeMarker();
      let seen: string | undefined | null = null;
      let pid = 0;
      for await (const ev of spawnProcess(process.execPath, ["-e", "console.log('up')"], {
        env: { [marker]: "1" },
      })) {
        if (ev.type === "stdout") {
          const live = liveChildProcesses().filter((c) => c.scopeMarker === marker);
          seen = live[0]?.scopeMarker;
          pid = live[0]?.pid ?? 0;
        }
      }
      expect(seen).toBe(marker);
      expect(pid).toBeGreaterThan(0);
      expect(liveChildProcesses().some((c) => c.pid === pid)).toBe(false);
    },
  );
});
