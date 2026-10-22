---
"@claudexor/schema": minor
"@claudexor/core": minor
"@claudexor/workspace": minor
"@claudexor/orchestrator": minor
"@claudexor/control-api": minor
"@claudexor/cli": minor
"@claudexor/mcp-server": minor
"@claudexor/harness-codex": minor
"@claudexor/harness-acp": patch
"@claudexor/harness-agy": patch
"@claudexor/harness-claude": patch
"@claudexor/harness-cursor": patch
"@claudexor/harness-fake": patch
"@claudexor/harness-opencode": patch
"@claudexor/harness-raw-api": patch
---

Add `execution.auxiliaryWritableRoots`: exact caller-created service directories (a shared download cache, outside-Git scratch) an Agent run with effective `workspace_write` may also write. Admission records the canonical list in `TaskContract.access.auxiliary_writable_roots` and refuses unsafe, missing or conflicting grants with typed codes, including any overlap with the execution or source tree. Lanes negotiate it through `capability_profile.access_control.auxiliary_writable_roots` and the catalog's `accessControl.auxiliaryWritableRoots`: Codex applies it per turn through its native sandbox policy; a new turn with no roots drops the earlier grant, while `continueFrom` with no execution group inherits the predecessor's whole group. Other adapters refuse an explicit pool and drop from Auto. The CLI gains repeatable `--auxiliary-writable-root`; MCP run tools, `claudexor_thread_turn` and ACP carry the same member.
