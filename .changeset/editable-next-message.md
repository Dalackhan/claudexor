---
"@claudexor/schema": patch
"@claudexor/daemon": patch
"@claudexor/control-api": patch
"@claudexor/orchestrator": patch
"@claudexor/cli": patch
"@claudexor/mcp-server": patch
---

Add operator-only editable next messages for daemon-owned one-shot Agent and Ask runs: `claudexor_next_message` and `claudexor_next_message_read`, CLI `next-message` and `next-message-read`, and HTTP `/v2/runs/next-message`. One revisioned draft reserves the predecessor's single successor claim. An eligible settled success sends it once as an ordinary continuation through the existing admission and queue; failure, unknown process custody, Stop, restart or admission refusal holds it without retry. Controls and Settings execution preferences are captured at creation and shown by origin on the bounded read, while permissions, trust, accounts and quota stay current at dispatch.

Public Stop (`POST /v2/runs/:id/control`, `claudexor_run_cancel`) holds a waiting draft whatever the predecessor's lifecycle and reports an already accepted successor as `next_message_dispatched` without cancelling it. If the hold cannot be saved, the run is still stopped, the draft is not sent, and Stop answers 503 `next_message_hold_failed`. `claudexor_run_cancel` failures now keep the control API's typed problem: their text starts with the code (for example `http_409: run is succeeded; cancel has nothing to stop`), and the structured failure carries the code, required actions and context.

The orchestrator exports `captureRunDefaults`, `executionRunConfig` and `resolveRunInputDefaults`, accepts captured `executionDefaults`, and adds `preflightOneShot` for dispatch validation without starting a run.

Engine-store schema 4 adds the `deferred_message` table in an atomic forward-only migration; older engines refuse an upgraded store.
