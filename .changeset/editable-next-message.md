---
"@claudexor/schema": patch
"@claudexor/daemon": patch
"@claudexor/control-api": patch
"@claudexor/cli": patch
"@claudexor/mcp-server": patch
---

Add operator-only editable next messages for daemon-owned one-shot Agent and Ask runs: `claudexor_next_message` and `claudexor_next_message_read`, CLI `next-message` and `next-message-read`, and HTTP `/v2/runs/next-message`. One revisioned draft reserves the predecessor's single successor claim. An eligible settled success sends it once as an ordinary continuation through the existing admission and queue; failure, unknown process custody, Stop, restart or admission refusal holds it without retry. Controls and Settings execution preferences are captured at creation and shown by origin on the bounded read, while permissions, trust, accounts and quota stay current at dispatch.

Public Stop (`POST /v2/runs/:id/control`, `claudexor_run_cancel`) holds a waiting draft whatever the predecessor's lifecycle and reports an already accepted successor as `next_message_dispatched` without cancelling it.

Engine-store schema 4 adds the `deferred_message` table in an atomic forward-only migration; older engines refuse an upgraded store.
