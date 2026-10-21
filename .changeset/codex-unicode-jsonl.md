---
"@claudexor/core": patch
"@claudexor/harness-codex": patch
---

Preserve U+2028 and U+2029 inside Codex run-adapter app-server JSON-RPC messages.
Frame protocol stdout on LF and scan each incoming chunk once, without changing
ordinary CLI line readers. Auxiliary auth, quota and login readers remain separate;
see the Unicode framing follow-up in `docs/BACKLOG.md`.
