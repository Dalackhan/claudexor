---
"@claudexor/schema": minor
"@claudexor/daemon": patch
"@claudexor/control-api": minor
"@claudexor/cli": minor
"@claudexor/mcp-server": minor
"@claudexor/harness-codex": patch
"@claudexor/harness-fake": patch
---

Add document ingress over the existing upload owner. MCP gains the upload stage tools (`claudexor_upload_create`, `claudexor_upload_import_local`, `claudexor_upload_status`, `claudexor_upload_finalize`, `claudexor_upload_cancel`) with matching CLI verbs, and public runs, thread turns and continuations accept strict `attachments: [{resourceId}]` refs. Codex carries verified references for TXT, Markdown, JSON, PDF and DOCX; this is byte access with no parsing or OCR promise.

A keyed import binds one source to one immutable resource under a saved store id and caller key: `claudexor_store_identity` and `claudexor_upload_import`, CLI `store-identity` and `upload-import`, and HTTP `POST /v2/uploads/imports`. A completed import replays its original resource before the client reads the source, even after the source changed or was deleted. Other arguments or other bytes under the same key are refused without effects, another store is refused before any effect, and verified bytes received before a lost reply or a daemon restart are published on replay. An import's interrupted or unverified transfer returns to `open` so the same key can resend it; ordinary uploads keep their single-shot cancellation. CLI runs take ready refs with `--attach-resource`.

Existing callers see three behavior changes. CLI `--attach` now labels `.pdf` and `.docx` files `application/pdf` and `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (previously `application/octet-stream`), so lane admission matches those types. Codex now declares TXT, Markdown and JSON as well as PDF and DOCX file inputs, so Auto routing keeps Codex for runs that carry them where it used to drop it, and explicit pools that include Codex now admit them; Auto and pool choices for such runs can change. The Delegate belt's run tools accept `attachments: [{resourceId}]` refs, while the belt still exposes no upload controls.
