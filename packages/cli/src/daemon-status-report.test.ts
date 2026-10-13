import { describe, expect, it } from "vitest";
import { daemonLoopLine } from "./daemon-status-report.js";

const facts = {
  windowMs: 10_004.25,
  windowEndedAt: "2026-10-10T10:00:00.000Z",
  delay: { resolutionMs: 10, samples: 912, p50Ms: 10.42, p99Ms: 41.9, maxMs: 812.03 },
  utilization: 0.4123,
  gc: { count: 7, totalMs: 23.5, maxMs: 9.25 },
};

describe("daemon status event-loop line", () => {
  it("states the last window's delay, busy share and GC pauses", () => {
    expect(daemonLoopLine({ ok: true, loop: facts })).toBe(
      "event loop, last 10.0 s: delay p50 10.4 ms, p99 41.9 ms, max 812.0 ms" +
        " (912 samples at 10 ms resolution); busy 41.2%; gc 7 pause(s), 23.5 ms total, max 9.3 ms",
    );
    expect(daemonLoopLine({ loop: { ...facts, delay: null, utilization: null } })).toContain(
      "no delay samples; busy unmeasured;",
    );
  });

  it("keeps absent, pending and malformed facts distinct", () => {
    expect(daemonLoopLine({ ok: true })).toBe("event loop: not reported by this daemon");
    expect(daemonLoopLine({ ok: true, loop: null })).toBe("event loop: no completed window yet");
    expect(daemonLoopLine({ loop: { ...facts, utilization: 2 } })).toBe(
      "event loop: unreadable facts",
    );
  });
});

describe("daemon status SQL facts", () => {
  it("prints exact migration work and unknown unopened metrics", async () => {
    const { daemonStoreLine } = await import("./daemon-status-report.js");
    const store = {
      flusher: null,
      flush_lag_ms: null,
      last_barrier_at: null,
      interval_ms: null,
      wal_bytes: null,
      busy_waits: null,
      commit: null,
      obligations_open: null,
      integrity: null,
      migration: null,
    };
    expect(daemonStoreLine({ store })).toBe(
      "engine store: integrity not open; flusher not open; flush lag unknown; WAL unknown; obligations unknown; COMMIT unknown",
    );
    expect(
      daemonStoreLine({
        store: {
          ...store,
          migration: {
            phase: "importing",
            completedPartitions: 2,
            totalPartitions: 10,
            currentPartition: "global",
            processedBytes: 1234,
            totalBytes: 5000,
          },
        },
      }),
    ).toBe("engine store: importing, 2/10 partitions, 1234/5000 bytes (global)");
    expect(daemonStoreLine({})).toBe("engine store: not reported by this daemon");
    expect(daemonStoreLine({ store: { integrity: "imagined" } })).toBe(
      "engine store: unreadable facts",
    );
  });

  it("states COMMIT facts since store open and keeps omitted, zero and malformed apart", async () => {
    const { daemonStoreLine } = await import("./daemon-status-report.js");
    const open = {
      flusher: null,
      flush_lag_ms: 0,
      last_barrier_at: null,
      interval_ms: 200,
      wal_bytes: 4152,
      busy_waits: 0,
      obligations_open: 0,
      integrity: "ok",
      migration: null,
    };
    const prefix =
      "engine store: integrity ok; flusher not open; flush lag 0.0 ms; WAL 4152 bytes; obligations 0; ";
    expect(
      daemonStoreLine({
        store: {
          ...open,
          commit: { attempts: 1234, failures: 2, last_ms: 0.042, max_ms: 41.864 },
        },
      }),
    ).toBe(
      `${prefix}COMMIT since store open: 1234 call(s), 2 failed, last 0.042 ms, max 41.864 ms`,
    );
    expect(
      daemonStoreLine({
        store: { ...open, commit: { attempts: 3, failures: 0, last_ms: 0, max_ms: 0 } },
      }),
    ).toBe(`${prefix}COMMIT since store open: 3 call(s), 0 failed, last 0.000 ms, max 0.000 ms`);
    expect(
      daemonStoreLine({
        store: { ...open, commit: { attempts: 0, failures: 0, last_ms: null, max_ms: null } },
      }),
    ).toBe(`${prefix}COMMIT since store open: 0 call(s), 0 failed`);
    // An older engine omits the group; that is neither unknown nor zero.
    expect(daemonStoreLine({ store: open })).toBe(`${prefix}COMMIT not reported by this daemon`);
    for (const commit of [
      { attempts: -1, failures: 0, last_ms: null, max_ms: null },
      { attempts: 1, failures: 0, last_ms: -0.5, max_ms: 1 },
      { attempts: 1.5, failures: 0, last_ms: 1, max_ms: 1 },
      { attempts: 1, failures: 0, last_ms: 1 },
      "fast",
    ]) {
      expect(daemonStoreLine({ store: { ...open, commit } })).toBe(
        "engine store: unreadable facts",
      );
    }
  });
});
