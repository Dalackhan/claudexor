---
"@claudexor/harness-claude": patch
---

A Claude run with `workspace_write` access can now read files outside its working folder. Under `acceptEdits` the permission bridge denied `Read`, `Glob` and `Grep` beyond the working directory, so a delegated run whose subject sits beside its own folder (a reviewer reading the reviewed folder in place) could read it only through Bash. The read tools are now pre-approved as `readonly` pre-approves them. File-tool edits stay confined to the working folder by `acceptEdits`; the pre-approved shell was already unconfined (`write_mechanism: tool_policy`). A caller who narrows reads with a `Read(...)`, `Glob(...)` or `Grep(...)` allow pattern gets no bare read tool, because Claude applies such a pattern to the whole read family; deny rules still win on their own, and a bare deny skips that one tool, as in `readonly`.
