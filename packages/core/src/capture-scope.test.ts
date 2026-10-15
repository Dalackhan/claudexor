import { expect, it } from "vitest";
import { runCaptureRaw } from "./proc.js";
import { liveChildProcesses, onChildProcessRegistered } from "./process-registry.js";
import { mintRunScopeMarker, scopeMarkerEnv } from "./process-scope.js";

// Real process/registry proof for the lifecycle-to-bounded-capture extraction.
// The kernel process-group registry is POSIX-only; Windows kill behavior has
// separate portable seams in proc.test.ts and native release qualification.
it.skipIf(process.platform === "win32")(
  "keeps the run scope registration through raw capture and retires it on close",
  async () => {
    const marker = mintRunScopeMarker();
    const seen: Array<{ pid: number; scopeMarker?: string }> = [];
    const unsubscribe = onChildProcessRegistered((child) => seen.push(child));
    try {
      const result = await runCaptureRaw(
        process.execPath,
        ["-e", "setTimeout(() => process.stdout.write('finished\\r\\n'), 100)"],
        { env: scopeMarkerEnv(marker), timeoutMs: 5000 },
      );
      expect(result).toEqual({ code: 0, signal: null, stdout: "finished\r\n", stderr: "" });
      const own = seen.filter((child) => child.scopeMarker === marker);
      expect(own).toHaveLength(1);
      expect(liveChildProcesses().some((child) => child.pid === own[0]!.pid)).toBe(false);
    } finally {
      unsubscribe();
    }
  },
);
