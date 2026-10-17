---
"@claudexor/workspace": patch
"@claudexor/orchestrator": patch
---

Keep a run's candidate when its working copy holds untracked folders with their own Git repository. The candidate capture used to stage everything with `git add -A`, which fails outright on a nested repository without a commit (and records a commit link for one with commits), so a finished agent-mode run — for example a reviewer that kept a copy of a repository under `.review-evidence/` — lost its whole work product. Untracked nested repositories that the worktree's `.gitmodules` does not declare are now left out of the patch, which cannot carry another repository anyway, and named top-relative and redacted as `excluded_nested_repositories` in the attempt record and the final work product's meta. A declared submodule is still captured as its commit link, the names stay correct when the project root is a subdirectory of the worktree, and the in-place turn snapshot leaves the same folders out, so a thread's next turn no longer fails on one an earlier turn left behind.
