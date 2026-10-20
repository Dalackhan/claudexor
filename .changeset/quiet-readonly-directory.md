---
"@claudexor/workspace": patch
"@claudexor/orchestrator": patch
---

Skip write-oriented baseline inventory and output capture for readonly live
directory Agents, so broad source scopes containing sockets do not block startup.
Keep writable/isolated capture and empty-answer delivery semantics unchanged.
