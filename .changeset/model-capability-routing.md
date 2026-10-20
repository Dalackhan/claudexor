---
"@claudexor/cli": minor
"@claudexor/control-api": minor
"@claudexor/daemon": patch
"@claudexor/harness-codex": patch
"@claudexor/mcp-server": minor
"@claudexor/schema": minor
---

Demote Codex accounts for a model after a typed pre-generation capability refusal. Prefer live catalogs listing the model, expose temporary capability marks and routing receipts, and support one correlated host retry as a separate model operation while preserving strict account pins and single-dispatch receipts. Hosts that branch on `model_unavailable` should note that a dispatched Codex 404 with explicit vendor `model_not_found` now returns `model_capability_refused` (it still records the model-scoped unusable verdict), and that `preferredProfileId` no longer wins over a listed account or when the preferred account is capability-marked.
