---
"@claudexor/workspace": patch
"@claudexor/orchestrator": patch
---

Skip write-oriented baseline inventory and output capture for readonly live
directory Agents, so broad source scopes containing sockets do not block startup
and source files are not copied into attempt artifacts. Readonly answers no longer
fail file capture because a selected path resembles a credential file. Align empty
answer delivery and readonly `noChanges` with the Git readonly convention: no
write-backed result, not a filesystem comparison. Writable and isolated directory
preparation and capture remain unchanged.
