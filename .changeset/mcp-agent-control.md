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

Add revision-guarded live run time-limit read, set, extend and disable controls,
soft warnings and optional inactivity-watchdog disabling. Existing explicit
maxSeconds limits remain hard by default; omitting a limit adds no deadline.
