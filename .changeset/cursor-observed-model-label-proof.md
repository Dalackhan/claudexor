---
"@claudexor/schema": patch
"@claudexor/core": patch
"@claudexor/orchestrator": patch
"@claudexor/harness-cursor": patch
---

Record exact catalog proof for Cursor's display-label model. Attempts keep the raw `init.model` string in `observed_model` and, in `final/telemetry.yaml`, add `observed_model_catalog_match` (`label`, `id`, `source: account_catalog`, `profile_id`) when the account catalog that the same spawn's processing preparation read lists exactly one row with that exact label and no row uses the string as an id. The per-spawn model gate is the only author and strips any value it did not compute; the attempt keeps the proof of the event that set `observed_model`, never a later try's, the requested model's or a normalized match, and drops it when the Agent or Ask/report loop starts another native try or a later event reports another model, so proof from an earlier try cannot verify a later answer. A missing, empty, unmatched or ambiguous catalog leaves the field null. No vendor call is added, and admission, routing and `auth_route.model_mismatch` are unchanged. The `HarnessEvent` and `RunTelemetry` JSON Schemas gain the optional field.
