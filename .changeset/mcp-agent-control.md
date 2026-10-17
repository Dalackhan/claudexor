---
"@claudexor/cli": minor
"@claudexor/mcp-server": minor
"@claudexor/daemon": minor
"@claudexor/control-api": minor
"@claudexor/schema": minor
"@claudexor/core": patch
"@claudexor/orchestrator": patch
"@claudexor/harness-codex": patch
"@claudexor/acp-server": patch
"@claudexor/config": patch
---

Let any controlling MCP agent inspect and answer native worker approvals through
the existing interaction tools. Codex workspace-write runs use native automatic
review and can hand back one exact denied action for an explicitly authorized
same-session retry, without changing managed policy or granting session-wide access.
A request the worker withdraws itself emits `interaction.withdrawn`, closing the
obsolete follow prompt or app card instead of blocking the next approval.

A completed Codex turn's answer, including a structured WorkReport envelope,
is kept before any handback; a denial that cannot be presented exactly is
disclosed and stands natively instead of failing the run. A thread that settles
in systemError never hands a denial back, authorizes it or starts another turn.

The verified Codex pin moves from codex-cli 0.156.1 to 0.162.1. Its captured
model snapshot makes `gpt-6.1-sol` the fallback default and a known model. An
installed 0.156.1 no longer matches the snapshot provenance: without a live
`model/list`, its effort snapshot is not trusted (no effort flag is sent) and
no turn-input bound is published for it.

Add revision-guarded live run time-limit read, set, extend and disable controls,
soft warnings and optional inactivity-watchdog disabling. Existing explicit
maxSeconds limits remain hard by default; omitting a limit adds no deadline, and
`set` keeps the timer's current mode unless one is named. Inactivity windows
longer than one Node timer delay are honored instead of firing immediately.
