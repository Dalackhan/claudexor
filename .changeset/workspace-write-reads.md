---
"@claudexor/harness-claude": patch
---

A Claude run with `workspace_write` access can now read files outside its working folder. Under `acceptEdits` the permission bridge denied `Read`, `Glob` and `Grep` beyond the working directory, so a delegated run whose subject sits beside its own folder (a reviewer reading the reviewed folder in place) could read it only through Bash. The read tools are pre-approved like Bash. File-tool edits stay confined to the working folder by `acceptEdits`; the pre-approved shell was already unconfined (`write_mechanism: tool_policy`). A caller who denies any of the three read tools, or passes a `Read(...)`, `Glob(...)` or `Grep(...)` pattern, keeps that shape: Claude applies such a rule to the whole read family, so none of the three is added.
