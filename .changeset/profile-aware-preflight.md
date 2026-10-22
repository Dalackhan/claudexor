---
"@claudexor/cli": patch
"@claudexor/orchestrator": patch
"@claudexor/control-api": patch
---

Attachment and Browser request admission now uses execution's pool projection, candidate membership and profile precedence. An explicit or inherited profile selects its harness even when the default harness home is logged out, a Settings default pool stays strict, and a missing, disabled or wrong-harness pin is refused with a typed `harness_unavailable` 400 instead of being substituted. Admission adds no selected-profile readiness gate; Auto retains host-status discovery for candidate membership. The run checks account readiness, quota and model before any provider starts. An empty Auto candidate pool now returns 400 `harness_unavailable`; static profile ambiguity returns 409 `credential_profile_ambiguous` after incompatible attachment lanes are removed. Browser-only Auto may still reject ambiguous AGY profiles on Windows that execution would have discarded as unready. A direct run that carries `threadId` is refused before admission reads that thread.
