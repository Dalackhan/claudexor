# Request-thread sync comparison, 2026-10-20

**Release gate: blocked.** The final candidate lowers COMMIT maxima and fixes runaway WAL growth in this workload, but does not establish a consistently lower p99 or event-loop tail. Do not merge/release on this evidence.

Base: `0919faac45dc34f67439bfb55443777143c9cfd0`. Final measured production tree: `fc6e52aa112271a41766454242f7019118270a3c`. macOS, Node 24.16.0, shared host. No managed daemon was contacted or changed.

## Reproduction

With the repository’s cached dependencies and supported Node installed:

```sh
node scripts/daemon-load-bench.mjs --base 0919faac4 --seconds 30 --rounds 6 --out results/acceptance.json
```

Both `--rounds N` and `--rounds=N` are accepted. A round is a pair of trials: AB, then BA, repeating, where A is base and B is candidate. Six rounds run twelve trials in three ABBA blocks; the default remains two rounds (one ABBA block). Any positive integer pair count is accepted. Use a process-tree watchdog sized for the requested count, allowing at least `2 * rounds * (seconds + 30)` seconds plus build time. The historical two-round runs below used the lane's 300-second watchdog.

Each build gets its own temporary root and HOME; the script stops its exact child PID and removes that root. The script archives the exact base and bundles each tree’s store, health, loop-facts and HTTP code. This is an isolated daemon composition with synthetic producers, not full provider/CLI bootstrap. Both trees use the same installed lockfile.

Each 30-second trial performs 6,000 model-shaped transactions over nine partitions, including a distinct 200 KiB external body every twentieth write, concurrently with 1,800 real run-detail requests from four paced clients. Detail parses a 100-event fixture, whose cursor the client checks. Status is polled every 250 ms through `GET /v2/daemon/status`, including the final completed ten-second loop window. Order is base/candidate, then candidate/base. Every trial completed all work with 6,001 COMMIT attempts (including setup), zero COMMIT failures and no flusher deaths. No separate disk stressor was added on the shared host.

The base predates COMMIT percentiles. An identical benchmark-only histogram observes the existing measured native COMMIT durations on both trees, after the timed call, and adds p50/p99 to the base status schema. It changes no SQL calls or pragmas. The candidate’s production request/synchronous timings remain enabled. Percentiles use two-significant-digit microsecond histograms; maxima are direct measurements. All numbers below come from status; loop maximum is the largest completed-window maximum, not an average of maxima.

## Quiet-host rerun handoff

The orchestrator owns the next full comparison. No 30-second comparison was rerun for the follow-up while eight implementation lanes shared the Mac (load1 28–43 in the final original comparison). The release blocker above remains until the quiet-host evidence establishes a lower tail. The original tables and JSON below are unchanged.

The updated harness prints one JSON `run_summary` line per trial to stdout, with separate `commit` p99/max and `eventLoop` tails, plus WAL and host-load observations. Start/stop PID messages go to stderr. The result file retains every trial, raw status samples in sibling files, and two `build_summary` records (also printed at the end). Build summaries report `worstRunP99Ms` for COMMIT, `worstWindowP99Ms` for the loop, and maxima separately. These are explicitly worst observed percentiles, not pooled p99s or averages; individual trial/window values remain available for comparison.

Every completed native loop window retains its worst labelled synchronous section and the maximum for each instrumented operation. An identical benchmark observer wraps the actual external-file writer and run-detail function bodies on both source trees, observes the already-timed native COMMIT, and times `BEGIN IMMEDIATE`. It records one maximum per label and resets at the same loop-roll boundary as status, then sends that window via IPC; HTTP polling cannot lose a window or its smaller later stalls. The last captured window is checked against the status response. Source instrumentation fails if either function is renamed or becomes asynchronous; it changes no SQL, pragmas, native sync calls or worker behavior.

Labels distinguish `store.external_write` (including O_DSYNC writes, unchanged by H1), `store.commit` (including base autocheckpoints/WAL-header syncs), `store.begin_immediate` (including writer-lock waits), and `control.run_detail`. The summary's maximum-loop window includes its worst section's label, duration and timestamps; each trial's `loops` array retains that attribution for every window. A worker checkpoint runs on another thread, so it is not labelled as a synchronous request-thread stall; any writer-lock wait appears under BEGIN. These labels identify the longest measured section **in the same window**, not proof that it caused the exact maximum delay sample. GC, uninstrumented work and host scheduling can also contribute. This attribution is available on both builds and does not depend on the production lifetime top-32 list.

## COMMIT latency (milliseconds)

| Candidate phase | Trial | Build | p99 | Max |
|---|---:|---|---:|---:|
| PASSIVE only | 1 | base | 10.367 | 288.261 |
| PASSIVE only | 1 | candidate | 39.935 | 1194.339 |
| PASSIVE only | 2 | candidate | 20.863 | 924.914 |
| PASSIVE only | 2 | base | 8.063 | 137.756 |
| RESTART at 64 MiB | 1 | base | 5.855 | 439.710 |
| RESTART at 64 MiB | 1 | candidate | 15.103 | 140.269 |
| RESTART at 64 MiB | 2 | candidate | 8.319 | 119.876 |
| RESTART at 64 MiB | 2 | base | 7.935 | 141.672 |
| RESTART at 4,000 frames (final) | 1 | base | 20.863 | 1295.484 |
| RESTART at 4,000 frames (final) | 1 | candidate | 21.375 | 269.633 |
| RESTART at 4,000 frames (final) | 2 | candidate | 18.687 | 393.881 |
| RESTART at 4,000 frames (final) | 2 | base | 28.671 | 2585.840 |

## Event-loop delay and WAL

| Candidate phase | Trial | Build | Loop max ms | Sampled WAL max MiB | Host load1 start → end |
|---|---:|---|---:|---:|---|
| PASSIVE only | 1 | base | 1032.323 | 16.915 | 12.24 → 16.90 |
| PASSIVE only | 1 | candidate | 1245.708 | 410.489 | 16.90 → 13.44 |
| PASSIVE only | 2 | candidate | 968.360 | 410.501 | 13.44 → 11.24 |
| PASSIVE only | 2 | base | 225.444 | 16.271 | 11.24 → 9.07 |
| RESTART at 64 MiB | 1 | base | 513.278 | 18.459 | 10.42 → 10.61 |
| RESTART at 64 MiB | 1 | candidate | 189.268 | 103.494 | 10.61 → 13.72 |
| RESTART at 64 MiB | 2 | candidate | 2420.113 | 113.556 | 14.71 → 12.87 |
| RESTART at 64 MiB | 2 | base | 176.030 | 15.870 | 12.87 → 13.44 |
| RESTART at 4,000 frames (final) | 1 | base | 1331.692 | 15.815 | 37.84 → 37.50 |
| RESTART at 4,000 frames (final) | 1 | candidate | 3539.993 | 25.441 | 36.34 → 43.17 |
| RESTART at 4,000 frames (final) | 2 | candidate | 1086.325 | 29.649 | 43.17 → 36.53 |
| RESTART at 4,000 frames (final) | 2 | base | 2661.286 | 16.726 | 36.53 → 28.38 |

## Findings

Removing the main autocheckpoint while keeping only background PASSIVE checkpoints allowed continuing writes to append past each captured checkpoint prefix. WAL grew to about 410 MiB. A worker RESTART attempt prevents indefinite reuse starvation when readers/writers permit it. The final trigger preserves the former 4,000-frame threshold, while the retained-file limit remains 64 MiB. Main `wal_autocheckpoint=0`, `checkpoint_fullfsync=0` and `fullfsync=0` were verified in every candidate; base readbacks were 4000/1/0.

RESTART can briefly exclude writers, while `busy_timeout=0` returns BUSY for an existing writer or pinned reader; it remains a soft target. It keeps checkpoint full syncs on the worker and retains the explicit WAL barrier. See [SQLite’s checkpoint mode contract](https://sqlite.org/pragma.html#pragma_wal_checkpoint). The pinned-reader regression exercises BUSY, release, reuse and the subsequent barrier.

The final comparison reduced worst COMMIT from 2,585.840 ms to 393.881 ms, but worst event-loop delay increased from 2,661.286 ms to 3,539.993 ms. Final p99 was slightly worse in round 1 (21.375 vs 20.863 ms), better in round 2 (18.687 vs 28.671 ms). The final candidate’s longest labelled synchronous sections were external file writes of 3,187.806 ms and 995.338 ms. These observed O_DSYNC stalls remain; moving checkpoint full syncs does not eliminate all synchronous filesystem waits. Host load1 varied substantially, reaching 43.17, so these trials cannot isolate environmental effects from the change.

All failed intermediate comparisons are retained above. The next release decision needs a controlled-host rerun of this harness; if that also fails, remaining synchronous external-file/storage work needs a separate implementation investigation. No passing result is claimed.

Durability/compatibility validation: all 398 store tests and all 577 control-API tests passed; timing/status/scope tests, build, test typecheck and generated schema validation also passed. Physical power failure was not simulated; barrier ordering, WAL recovery, process-kill recovery, pinned readers, worker restart and close ordering were exercised.

Machine-readable measurements: [daemon-sync-20261020.json](daemon-sync-20261020.json).
