# Model capability refusals

An account that cannot serve a requested Codex model is demoted for that model.
Other models, account enablement, quota and authentication retain their existing
rules. Each model operation still sends inference at most once.

Auto selection reads live per-account catalogs. It prefers a listed model,
then an advisory miss, then a marked account. A preference applies within those
groups, so a listed alternative wins over an unlisted or marked preferred
account; a pin stays exact. A marked account remains usable as a last fallback.
Catalog acquisition failure does not become an advisory miss.

## Host retry

The result and operation detail carry `problem.code = model_capability_refused`.
Only pre-generation HTTP 400/404 refusals enter this channel. Recognized cases
are `model_not_found`/`model_not_supported`, the exact Codex ChatGPT-account
unsupported-model sentence, and narrowly matched missing-model sentences.
Unsupported parameters, malformed input, context length, quota, authentication,
stream errors and uncertain delivery retain their previous classifications.

Read these fields from `problem.context`:

| Field | Meaning |
| --- | --- |
| `generationStarted` | `false` for this refusal |
| `retryOnOtherAccount` | Whether one separate auto operation may try another eligible account |
| `retryBlockedBy` | `native_continuation` when history continuation bound to the refusing account withholds the signal; absent otherwise |
| `operationId` | Operation that returned this problem |
| `source`, `requestedModel` | Requested transport and model |
| `credentialProfileId`, `accountFingerprint` | Refusing account; fingerprint may be null |
| `providerReason` | Provider reason, processed by the shared secret redactor and bounded to 1024 characters |
| `capabilityKind` | `model_not_supported` or `model_not_found` |
| `capabilityEvidence` | `provider_code` or `provider_text` |
| `accountMode` | `auto` or `pin` |
| `accountsTried[]` | Each tried account's `credentialProfileId`, `accountFingerprint`, `providerReason`, `capabilityKind` |
| `nextStep` | Actionable guidance for the host/owner |
| `retryOfOperationId`, `differentialOutcome` | Present on a correlated retry refusal |

`problem.retryable` remains false: retrying the same route is not requested.
The separate signal is false for a pin, after the correlated retry, when
history continuation is bound to the refusing account, or when fresh admission
cannot find another account. A catalog only establishes eligibility to attempt;
it cannot guarantee that the provider will serve.

Send `retryOfOperationId` ONLY in response to `context.retryOnOtherAccount=true`.
Only engines supporting the field emit that signal; older engines with strict
request schemas must never receive it.

When the signal is true, upload the same `ModelCallRequest` with the optional
`retryOfOperationId` set to the first operation's id. Keep `account.mode=auto`.
Use a new operation/idempotency key; replaying the old key returns the old
receipt. Generation inputs must match, including messages, tools, options and
native continuation. The engine excludes the original profile and, when known,
its account fingerprint. The correlation can be claimed once, within four
hours and in the same daemon lifetime. Invalid, reused, changed-input or expired
correlation fails before inference with `model_retry_invalid`. A daemon restart
also forgets the correlation. In every case below, keep the original refusal
as the owner-facing error and stop; never repeat the retry without correlation:

| `model_retry_invalid` cause | Host action |
| --- | --- |
| Daemon restart (or evidence eviction) | Give up with the original error; do not retry uncorrelated |
| Four-hour expiry or changed account/catalog binding | Give up with the original error; do not retry uncorrelated |
| Correlation already used | Give up with the original error; do not retry uncorrelated |
| Changed generation input or pinned account | Give up with the original error; do not retry uncorrelated |

Account-bound history withholds this retry. A historical assistant turn's
`messages[].nativeContinuation` (`codex.responses.v1`) replays only on the
account and profile that produced it; on another account the request fails
locally with `invalid_continuation` before inference. Removing the payload
changes the generation input, and an assistant turn may consist only of native
payload, so stripping is not equivalent. When any message continuation is bound
to the refusing account's profile or fingerprint, the engine returns
`retryOnOtherAccount=false` with `retryBlockedBy=native_continuation` and still
records the provisional mark, which steers later auto operations elsewhere.
History bound to another account cannot produce this refusal: the selected
account rejects it locally with `invalid_continuation` before inference. Because
listed-first selection can move an auto request away from its preferred account,
a host whose history carries account-bound continuations should pin that account.
A top-level `codex.turn.v1` transport continuation from another route resets to
none and is not sent, so it never blocks.

Success confirms the first account's mark. A refusal of the same capability kind
on the other account retracts this pair's evidence. The returned problem keeps
the first refusal's code, message and provider reason, with both accounts in
`accountsTried` and `differentialOutcome=equivalent_refusal`. Independent
concurrent failures retain their own evidence. A different failure or uncertain
outcome is inconclusive; it neither confirms nor retracts the first mark. The
host must stop after this one retry and can use the combined diagnostics in its
owner-facing error. The engine sends no chat messages.

## Marks and receipts

`GET /v2/accounts/routing-evidence` adds optional `capabilities[]` entries:

| JSON path | Meaning |
| --- | --- |
| `capabilities[].harness_id`, `.profile_id` | Account-row join key |
| `capabilities[].requested_model` | Only model affected |
| `capabilities[].account_fingerprint` | Account identity, nullable |
| `capabilities[].provider_reason` | Redacted provider reason |
| `capabilities[].observed_at` | Start of the retained evidence |
| `capabilities[].expires_at` | Next probe eligibility time; not a quota reset |
| `capabilities[].state` | `provisional`, `confirmed`, `probe_due`, or `probing` |

`MODEL_CAPABILITY_TTL_MS` is four hours. After expiry one concurrent auto
operation may own the account's probe. A probing account sorts after every
other eligible candidate, including marked fallbacks. If no alternative remains,
a concurrent operation may still dispatch there without taking probe ownership;
marks never exclude the last eligible account. Success clears the mark; refusal
renews it. Bound outcome ordering prevents an older refusal from undoing newer
service or releasing a newer probe.
Unknown/cancelled probes postpone the next probe by four hours. Fresh catalog
content or identity changes clear it early. Codex's opaque catalog
`capabilityFingerprint` includes the plan claim without changing the stable
`accountFingerprint` used by continuations. Managed credential changes also
invalidate outstanding bindings. While a login holds the credential-mutation
window, generations are unknown rather than changed: operations proceed, nothing
is recorded, cleared or confirmed, and existing marks keep ordering selection. External capability changes are recognized on
the next execution discovery or uncached account-catalog read. Accounts Refresh
refreshes readiness and quota; for model catalogs it only invalidates the
display cache, preparing it for the next uncached read. Ordinary cached catalog
and read-only status responses do not acquire new evidence.

The compact journal receipt, operation detail and result carry `routing`:
`selectionReason` is `listed`, `unlisted_fallback`, `marked_fallback`, `preferred`,
`pinned`, or `probe`. `poolEvents` retains the resolver's existing typed event
names and payloads. `differentialOutcome` is `provisional`, `confirmed`,
`equivalent_refusal`, or `inconclusive`; correlated operations also carry
`retryOfOperationId`. Preference orders unmarked accounts within the listed or
unlisted tier; any capability row suppresses the preferred-account shortcut.
In an ordinary operation an expired mark may re-enter its catalog tier as a
`probe`. In a correlated retry, every capability row (including `probe_due`)
stays fallback-only so an unmarked comparator wins when available. An account
already `probing` sorts after all other fallbacks. No second dispatch is added
to a receipt.

The ledger stores hashes for catalog invalidation, not reusable catalogs. It is
process-local and bounded to 512 entries per map; restart or eviction forgets
routing evidence. The host must use correlation for deterministic differential
settlement. An unrelated later success on another account does not confirm a
mark. A success on the marked account clears its own mark. Old strict schema
consumers need the updated response schemas to accept the added fields.
