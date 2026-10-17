---
"@claudexor/workspace": patch
"@claudexor/orchestrator": patch
---

Keep a run's candidate when its working copy holds untracked folders with their own Git repository. The candidate capture used to stage everything with `git add -A`, which fails outright on a nested repository without a commit (and records a commit link for one with commits), so a finished agent-mode run — for example a reviewer that kept a copy of a repository under `.review-evidence/` — lost its whole work product. Untracked nested repositories are now left out of the patch, which cannot carry another repository anyway, and named in the attempt record as `excluded_nested_repositories`.
