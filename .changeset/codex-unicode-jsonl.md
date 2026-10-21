---
"@claudexor/core": patch
"@claudexor/harness-codex": patch
---

Preserve U+2028 and U+2029 inside Codex app-server JSON-RPC messages. Frame
protocol stdout on LF instead of treating Unicode text separators as line
boundaries, without changing ordinary CLI line readers.
