# @claudexor/control-api

## 4.7.1

### Patch Changes

- 30f8195: Preserve optional caller-generated task group membership in accepted one-shot jobs and their receipts. Tagged receipts identify the accepting store, Exact Retry retains membership, and new continuations join a group only when explicitly requested. Add atomic engine-store schema version 3 expression indexes for retained group membership.

  Recover original queued and bound job handles with the bounded `task-group-runs` CLI, `claudexor_task_group_runs` MCP tool and HTTP group page. Store/view/filter-bound cursors require explicit paging; compact member observations share the multi-run attention contract. Results cover retained rows in currently served generations, not a permanent roster. Discovery adds no launch, retry, resume, answer, permissions or budget authority.

  Document durable caller receipts, exact keyed replay, separate interaction/result reads and storage downgrade precautions. Add deterministic built CLI/MCP/HTTP qualification stories for controller loss, queued binding, replay conflicts, store mismatch, archive visibility and daemon-crash interruption without autoresume. Manual host UI and real-vendor qualification remain separate.

- Updated dependencies [880081d]
- Updated dependencies [30f8195]
  - @claudexor/schema@4.7.1
  - @claudexor/delivery@4.7.1
  - @claudexor/event-log@4.7.1
  - @claudexor/workspace@4.7.1
  - @claudexor/secrets@4.7.1
  - @claudexor/util@4.7.1

## 4.7.0

### Minor Changes

- 74fb275: Add `execution.auxiliaryWritableRoots`: exact caller-created service directories (a shared download cache, outside-Git scratch) an Agent run with effective `workspace_write` may also write. Admission records the canonical list in `TaskContract.access.auxiliary_writable_roots` and refuses unsafe, missing or conflicting grants with typed codes, including any overlap with the execution or source tree. Lanes negotiate it through `capability_profile.access_control.auxiliary_writable_roots` and the catalog's `accessControl.auxiliaryWritableRoots`: Codex applies it per turn through its native sandbox policy; a new turn with no roots drops the earlier grant, while `continueFrom` with no execution group inherits the predecessor's whole group. Other adapters refuse an explicit pool and drop from Auto. The CLI gains repeatable `--auxiliary-writable-root`; MCP run tools, `claudexor_thread_turn` and ACP carry the same member.

### Patch Changes

- Updated dependencies [74fb275]
  - @claudexor/schema@4.7.0
  - @claudexor/workspace@4.7.0
  - @claudexor/delivery@4.7.0
  - @claudexor/event-log@4.7.0
  - @claudexor/secrets@4.7.0
  - @claudexor/util@4.7.0

## 4.6.2

### Patch Changes

- @claudexor/delivery@4.6.2
- @claudexor/event-log@4.6.2
- @claudexor/schema@4.6.2
- @claudexor/secrets@4.6.2
- @claudexor/util@4.6.2
- @claudexor/workspace@4.6.2

## 4.6.1

### Patch Changes

- ed646a5: Attachment and Browser request admission now uses execution's pool projection, candidate membership and profile precedence. An explicit or inherited profile selects its harness even when the default harness home is logged out, a Settings default pool stays strict, and a missing, disabled or wrong-harness pin is refused with a typed `harness_unavailable` 400 instead of being substituted. Admission adds no selected-profile readiness gate; Auto retains host-status discovery for candidate membership. The run checks account readiness, quota and model before any provider starts. An empty Auto candidate pool now returns 400 `harness_unavailable`; static profile ambiguity returns 409 `credential_profile_ambiguous` after incompatible attachment lanes are removed. Browser-only Auto may still reject ambiguous AGY profiles on Windows that execution would have discarded as unready. A direct run that carries `threadId` is refused before admission reads that thread.
  - @claudexor/delivery@4.6.1
  - @claudexor/event-log@4.6.1
  - @claudexor/schema@4.6.1
  - @claudexor/secrets@4.6.1
  - @claudexor/util@4.6.1
  - @claudexor/workspace@4.6.1

## 4.6.0

### Minor Changes

- a81897c: Choose the native prompt-cache lifetime of Claude Code sessions per run: `POST /v2/runs` and `POST /v2/threads/:id/turns` accept `promptCacheTtl: "5m" | "1h"` (CLI `--prompt-cache-ttl`, including plan answers the same command submits inline), and omission keeps native defaults, profile settings and the inherited environment. Adapters declare the values they translate in `capability_profile.prompt_cache_ttls`; `GET /v2/agent-capabilities` projects them as `harnesses[].promptCacheTtls` and lists the key in `runControlKeys`. The value is frozen into the task contract, inherited by a bare `continueFrom` (a successor cannot go back to Default; that takes a new run), re-injected by Exact Retry, and forwarded to task lanes, the continuity summary, reviewers and delegation-belt children on declaring harnesses. Elsewhere it is an `ignored_settings` disclosure, except in best-of synthesis, which emits no `harness.started`: an undeclared synthesis harness runs without the lifetime and without a disclosure. The deep-scan reducer's `harness.started` now discloses every route knob its harness ignores, including `max_turns` and tool lists. The Claude adapter sets `CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, keeps forcing and disabling controls, and discloses the ones known to govern instead (and a known older CLI). Each Claude attempt records `prompt_cache_ttl` in `final/telemetry.yaml` with the lifetime routed to its sessions (`requested`), the configured value and the observed split of the reported five-minute and one-hour cache-write tokens; an unreported split stays unknown.

### Patch Changes

- Updated dependencies [a81897c]
- Updated dependencies [2593b90]
  - @claudexor/schema@4.6.0
  - @claudexor/util@4.6.0
  - @claudexor/delivery@4.6.0
  - @claudexor/workspace@4.6.0
  - @claudexor/event-log@4.6.0
  - @claudexor/secrets@4.6.0

## 4.5.0

### Minor Changes

- 032b44b: Demote Codex accounts for a model after a pre-generation refusal. A recognized capability refusal (`model_capability_refused`) marks the account at once; any other definite provider HTTP 4xx before generation on an auto operation (outside sign-in, timeouts, conflicts, rate and quota limits, the processing fallback, server failures and typed request faults) offers the same single correlated host retry, which becomes a confirmed mark when another account serves and marks nothing when it refuses too. Both kinds also record the shared pre-progress refusal observation, so Agent runs of that model order the account last as well, and an older in-flight refusal never undoes a newer model operation's service. Auto selection prefers accounts whose live catalog lists the model, then advisory misses, then accounts with only a soft observation (a recent refusal, or a served-model substitution of a non-preferred account), then capability-marked accounts; history bound to an unmarked, unrefused preferred account stays on that account. Refusal problems carry `modelMarks` (each live mark with the start of its episode) and `alternativeRemains` (whether another selectable account without a mark remains). Routing receipts (`captureRoutingEvidence=true` on `POST /v2/model-operations`) and capability rows (`includeCapabilities=true` on `GET /v2/accounts/routing-evidence`) are opt-in over HTTP, so strict 4.4.0 clients keep their shapes; Claudexor's own CLI and MCP readers request the rows. Behavior change: the recognized Codex refusals (an explicit `model_not_found` or `model_not_supported` code, the ChatGPT-account unsupported-model sentence, the narrow missing-model sentences) now return `model_capability_refused` instead of `invalid_request` or `model_unavailable` (an explicit vendor `model_not_found` still records the model-scoped unusable verdict), and `preferredProfileId` no longer wins over a listed account or over its own mark or recent refusal; history bound to that account keeps it first over a catalog miss only while it has neither.

### Patch Changes

- Updated dependencies [032b44b]
- Updated dependencies [85e312d]
  - @claudexor/schema@4.5.0
  - @claudexor/workspace@4.5.0
  - @claudexor/delivery@4.5.0
  - @claudexor/event-log@4.5.0
  - @claudexor/secrets@4.5.0
  - @claudexor/util@4.5.0

## 4.4.0

### Minor Changes

- Daemon status reports per-route request latency (one count of completed responses or disconnects with p50, p99 and max for the lifetime and the last loop window, keyed by HTTP method and operation-catalog template) and the 32 longest labelled synchronous sections since start (store BEGIN and COMMIT, external writes, run detail and summary projections, scope persistence), plus lifetime COMMIT p50 and p99. A request whose client has already hung up skips its pending heavy read projections; an admitted mutation still completes. `POST /v2/handshake` returns the durable engine store id as `storeId` to a client that sends `X-Claudexor-Store-Identity: 1`, and every other client keeps the earlier response shape. `scripts/daemon-load-bench.mjs` compares an exact base against the working tree in alternating trials inside temporary roots it owns. Moving checkpoints off the request thread was measured and not adopted: it lowered COMMIT tails but not the event-loop tail consistently (`docs/benchmarks/daemon-sync-20261020.md`).
- Engine retention retires unregistered and archived project histories, orphaned run trees and unreferenced native session parts in recurring bounded maintenance and never removes anything still referenced; immutable attempt, final and anchor patches share one content-addressed object per project where hard links are supported (#477).
- MCP controllers get idempotent one-shot launches and durable run supervision: `claudexor_run_wait`, `claudexor_run_message`, `claudexor_run_continue` and bounded `claudexor_run_event_read` parts. Thanks to @IlidanNaga (#478).

### Patch Changes

- Updated dependencies
  - @claudexor/util@4.4.0
  - @claudexor/schema@4.4.0
  - @claudexor/delivery@4.4.0
  - @claudexor/event-log@4.4.0
  - @claudexor/secrets@4.4.0
  - @claudexor/workspace@4.4.0

## 4.3.1

### Patch Changes

- Updated dependencies [64ee7fc]
  - @claudexor/workspace@4.3.1
  - @claudexor/delivery@4.3.1
  - @claudexor/event-log@4.3.1
  - @claudexor/schema@4.3.1
  - @claudexor/secrets@4.3.1
  - @claudexor/util@4.3.1

## 4.3.0

### Minor Changes

- Ordinary Codex Fast (`fast`/`priority`) on a verified ChatGPT subscription is included service under no-paid routing and every cash cap, including `finite(0)`; verified Codex subscription work now reports its cash as unknown (`spendUsd` and `budget_summary.spend_usd` null, cost basis `debit: "unobserved"`) beside the cap-governed `controllableSpendUsd` instead of exact zero, and without a preference keeps the first account's chosen speed across retries, Exact Retry, rotation and continuation (#468, thanks @IlidanNaga). Codex catalogs keep a declared `inputModalities` list only when it is wholly valid and non-empty, as metadata that gates no request (#435, thanks @josephsteuerjr). The opt-in `GET /v2/quota?view=resources_freshness` view adds a required `availability_scope` echo, Cursor accounts report dated display-only monetary resources from Cursor's internal dashboard through the existing refresh cycle, and Antigravity's native headless permission auto-denial becomes typed `permission_denial` evidence without retry or access elevation (#467).

  Codex workspace-write uses native on-request with auto_review by default and an explicit one-action retry handback; HTTP/MCP can revise the existing live soft/hard timer, and configuration can disable only inactivity timing with null (#466, thanks @IlidanNaga). This adds no session-wide grant, readonly bypass, automatic retry authorization by Claudexor, per-run idle field or installed CLI update; timers are not restored after daemon loss and native UI/vendor qualification remains limited.

- 23a74cb: Let any controlling MCP agent inspect and answer native worker approvals through
  the existing interaction tools. Codex workspace-write runs use native automatic
  review and can hand back one exact denied action for an explicitly authorized
  same-session retry, without changing managed policy or granting session-wide access.
  A request the worker withdraws itself emits `interaction.withdrawn`, closing the
  obsolete follow prompt or app card instead of blocking the next approval.

  A completed Codex turn's answer, including a structured WorkReport envelope,
  is kept before any handback; a denial that cannot be presented exactly is
  disclosed and stands natively instead of failing the run. A thread that settles
  in systemError never hands a denial back, authorizes it or starts another turn.

  The verified Codex pin moves from codex-cli 0.156.1 to 0.162.1. Its captured
  model snapshot makes `gpt-6.1-sol` the fallback default and a known model. An
  installed 0.156.1 no longer matches the snapshot provenance: without a live
  `model/list`, its effort snapshot is not trusted (no effort flag is sent) and
  no turn-input bound is published for it.

  Add revision-guarded live run time-limit read, set, extend and disable controls,
  soft warnings and optional inactivity-watchdog disabling. Existing explicit
  maxSeconds limits remain hard by default; omitting a limit adds no deadline, and
  `set` keeps the timer's current mode unless one is named. Inactivity windows
  longer than one Node timer delay are honored instead of firing immediately.

### Patch Changes

- Updated dependencies
- Updated dependencies [23a74cb]
  - @claudexor/schema@4.3.0
  - @claudexor/delivery@4.3.0
  - @claudexor/workspace@4.3.0
  - @claudexor/event-log@4.3.0
  - @claudexor/secrets@4.3.0
  - @claudexor/util@4.3.0

## 4.2.0

### Patch Changes

- @claudexor/delivery@4.2.0
- @claudexor/event-log@4.2.0
- @claudexor/schema@4.2.0
- @claudexor/secrets@4.2.0
- @claudexor/util@4.2.0
- @claudexor/workspace@4.2.0

## 4.1.1

### Patch Changes

- @claudexor/delivery@4.1.1
- @claudexor/event-log@4.1.1
- @claudexor/schema@4.1.1
- @claudexor/secrets@4.1.1
- @claudexor/util@4.1.1
- @claudexor/workspace@4.1.1

## 4.1.0

### Minor Changes

- Generate and edit images through subscription-backed Codex accounts as a payload kind of the existing caller-owned model operations. Upload an `ImageCallRequest` with `purpose: "model"` and create it with `POST /v2/model-operations?requestKind=image` (omission stays text): the same idempotency key, queue, SQL flush barrier before the provider request, cancellation, private result with 30-day unacknowledged retention and whole-result digest ACK serve both kinds, with no second scheduler and no subscription-to-API fallback. A failed barrier or a cancellation before the request reports that nothing was sent. `ImageCallResult` keeps the requested model apart from the provider-observed route model, the applied options, reported usage, unknown cash and every usable image with its verified MIME, size and digest; rejected siblings are named in the problem context instead of discarding the good ones. `GET /v2/model-sources?view=accounts` declares the source's structural `imageGeneration` facet, whose model ids are presence hints, not an entitlement. Quota constraints may declare `applies_to_request_kinds` (absent applies to both kinds): Codex `codex`/`default` windows are text and `image_gen` is image, an image 429 with an observed reset enters the registry as image-only evidence, and `GET /v2/quota` (including its resources and constraint-freshness views) and `POST /v2/quota` accept optional `requestKind` and `model`. Image windows stay visible in Accounts, labelled, but no longer drive text availability, the compact text percentage, the cooldown badge or a run's quota-pressure disclosure; legacy unscoped windows keep applying to both kinds until a newer measured scoped read replaces them. Unrecognised Codex full-read and rollout buckets are no longer recorded as quota constraints; notification payloads retain diagnostic evidence without guessed applicability. Request-kind availability selection is HTTP-only; CLI/MCP remain text-default. Live proof covers one generation and one edit through the real adapter on one managed account before the SQL store; SQL custody is covered by real-store tests over a synthetic endpoint, and other accounts' entitlement, image quota headers and the released live chain remain unverified. Thanks to @josephsteuerjr for the original image-operations contribution (#428).

### Patch Changes

- Updated dependencies
  - @claudexor/schema@4.1.0
  - @claudexor/delivery@4.1.0
  - @claudexor/event-log@4.1.0
  - @claudexor/workspace@4.1.0
  - @claudexor/secrets@4.1.0
  - @claudexor/util@4.1.0

## 4.0.1

### Patch Changes

- @claudexor/delivery@4.0.1
- @claudexor/event-log@4.0.1
- @claudexor/schema@4.0.1
- @claudexor/secrets@4.0.1
- @claudexor/util@4.0.1
- @claudexor/workspace@4.0.1

## 4.0.0

### Minor Changes

- 2fbf7c9: Keep the daemon responsive under load without changing any on-disk format. The control API, model operations and harness maintenance reach the daemon's dispatcher in process (`DaemonLocalClient`), so a slow event loop no longer turns their calls into ten-second `daemon_busy` failures; problem fields are unchanged and socket clients keep their transport bound. `ControlDaemonStatus.loop` reports the last ten-second event-loop window (delay p50/p99/max, busy share, GC pauses) as facts, and `claudexor daemon status` prints it. `POST /v2/projects` answers `created`, which `claudexor project register` prints. Run detail reads `lastSeq` from the live writer or the log tail, the project list computes nesting in one pass, `appendLine` takes Node's UTF-8 write without a mkdir per line, Codex rate limits are read incrementally, pid snapshots are written asynchronously on change only, per-request config reads reuse the parse until a source changes, and the control API sets explicit HTTP keep-alive, header and request timeouts.

### Patch Changes

- Updated dependencies [2fbf7c9]
  - @claudexor/schema@4.0.0
  - @claudexor/event-log@4.0.0
  - @claudexor/util@4.0.0
  - @claudexor/delivery@4.0.0
  - @claudexor/workspace@4.0.0
  - @claudexor/secrets@4.0.0

## 3.25.1

### Patch Changes

- @claudexor/delivery@3.25.1
- @claudexor/event-log@3.25.1
- @claudexor/schema@3.25.1
- @claudexor/secrets@3.25.1
- @claudexor/util@3.25.1
- @claudexor/workspace@3.25.1

## 3.25.0

### Minor Changes

- Expose independently dated account resources and explicit Codex and Claude resets through the control API, CLI, MCP and native Accounts. Preserve original request identity through uncertain outcomes and keep provider results separate from resource refresh.

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.25.0
  - @claudexor/delivery@3.25.0
  - @claudexor/event-log@3.25.0
  - @claudexor/workspace@3.25.0
  - @claudexor/secrets@3.25.0
  - @claudexor/util@3.25.0

## 3.24.0

### Minor Changes

- Add shared vendor CLI inspection and maintenance with durable update, cancellation and previous-version evidence. Preserve newer managed installations and support native Cursor and Antigravity updates. Permit explicit Codex models absent from a successful catalog without misreporting account availability as exhausted quota.

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.24.0
  - @claudexor/delivery@3.24.0
  - @claudexor/workspace@3.24.0
  - @claudexor/event-log@3.24.0
  - @claudexor/secrets@3.24.0
  - @claudexor/util@3.24.0

## 3.23.2

### Patch Changes

- Preserve typed idempotency lookup failures and safe underlying causes without losing same-key recovery. Pin canary daemons to the built candidate and retain fixture evidence when cleanup cannot prove the root inactive.
  - @claudexor/delivery@3.23.2
  - @claudexor/event-log@3.23.2
  - @claudexor/schema@3.23.2
  - @claudexor/secrets@3.23.2
  - @claudexor/util@3.23.2
  - @claudexor/workspace@3.23.2

## 3.23.1

### Patch Changes

- @claudexor/delivery@3.23.1
- @claudexor/event-log@3.23.1
- @claudexor/schema@3.23.1
- @claudexor/secrets@3.23.1
- @claudexor/util@3.23.1
- @claudexor/workspace@3.23.1

## 3.23.0

### Patch Changes

- @claudexor/delivery@3.23.0
- @claudexor/event-log@3.23.0
- @claudexor/schema@3.23.0
- @claudexor/secrets@3.23.0
- @claudexor/util@3.23.0
- @claudexor/workspace@3.23.0

## 3.22.1

### Patch Changes

- 902532e: Select retained commands by an explicit address before compact collection projection, preserving exact retry, HTTP run pages, continuation admission and uncapped cancellation. Remove the control API's whole-history self-RPC and make project activity checks synchronous with removal.

  Report daemon transport failures as retryable 503 problems while preserving typed refusal context and required actions; a thread turn whose enqueue answer was lost stays retryable and its retry reads the journal instead of enqueueing a duplicate. Untyped enqueue failures on POST /v2/runs now carry code internal_error instead of http_500. Refuse an admitted continuation whose source vanished before starting any harness work.

  Expose current and admission memory through authenticated GET /v2/daemon/status without changing the handshake. Publish engine heap launch arguments in the additive probe contract and apply them in the CLI and the macOS app launcher, honoring explicit NODE_OPTIONS. Resident journal-history growth and archive continuation remain outside this patch.

- Updated dependencies [902532e]
  - @claudexor/schema@3.22.1
  - @claudexor/util@3.22.1
  - @claudexor/delivery@3.22.1
  - @claudexor/event-log@3.22.1
  - @claudexor/workspace@3.22.1
  - @claudexor/secrets@3.22.1

## 3.22.0

### Minor Changes

- 51578d4: Continue a stopped run instead of restarting it: `POST /v2/runs {continueFrom: <runId>, continueCarrier?: "auto" | "packet"}` starts the next run of a continuation chain. Admission is one daemon-atomic rule shared by every ingress (`predecessor_unknown`, `predecessor_live`, `continue_from_with_thread`, `continue_from_unsupported`, `continuation_superseded` with the chain `head`): the accepted successor command is the durable claim, so a predecessor has exactly one accepted successor, also across restarts and concurrent requests. Omitted mode, scope, execution, harness and model come from the predecessor, and the prompt is the caller's continuation text (it may be empty). The successor's first try is planned through the in-run continuation planner from the predecessor's session capsule and terminal facts — the same account resumes the vendor session by id, another account resumes the moved session, otherwise a fresh session is briefed with the evidence index — and is disclosed by a `run.continuity` receipt naming the predecessor and whether it runs in the same root. A stopped isolated Agent run now keeps its envelope (tree and scoped home, Claudexor-seeded auth removed) under a durable custody record until a successor adopts it, its result is applied or it is discarded; the crash sweep and disk retention keep it, and a run interrupted by a daemon restart with changes is kept the same way. `GET /v2/runs/:id` projects `resumable` (derived as `host_restart` for runs the daemon found running at its restart), the per-try `continuity` receipts, `retainedEnvelope` (disk use) and `continueFrom`; `continueFrom` is advertised in `runControlKeys`.

### Patch Changes

- Updated dependencies [51578d4]
- Updated dependencies [785bba7]
  - @claudexor/schema@3.22.0
  - @claudexor/workspace@3.22.0
  - @claudexor/event-log@3.22.0
  - @claudexor/delivery@3.22.0
  - @claudexor/secrets@3.22.0
  - @claudexor/util@3.22.0

## 3.21.0

### Patch Changes

- 9ccd45d: A secret-like string in agent output no longer rolls back an in-place patch, discards an isolated candidate or drops the answer. The changed files keep the exact bytes; the saved `patch.diff` copies and reviewer packets carry `[redacted]` (a flagged binary payload is withheld), and the run discloses paths and counts in `secret_like` (attempt record, work-product meta, one `summary.md` line, `secretLike` on the MCP read tools), never a matched value. `patch_sha256` stays the digest of the exact patch: Apply, apply/check and the `accept_risk` binding read a private exact patch object and answer 409 `patch_exact_bytes_unavailable` when it is missing. `pr` delivery refuses a secret-like patch before any push while local apply, branch and commit stay allowed; served media and other binaries that match the content policy answer 409 `secret_like_content_withheld`; the raw API no longer refuses a proposal for its content. Only a capture that cannot observe the changes is still a refusal, now named `capture_refusal` in phase `workspace` (the `secret_diff_refusal` attempt field, the `secret_diff_refused` / `secret_recovery` work-product fields and the `artifact_security` phase for patch runs are gone).
- Updated dependencies [7c541ba]
- Updated dependencies [f0ab916]
- Updated dependencies [83bc0da]
- Updated dependencies [9ccd45d]
- Updated dependencies [a4ff572]
  - @claudexor/schema@3.21.0
  - @claudexor/util@3.21.0
  - @claudexor/workspace@3.21.0
  - @claudexor/delivery@3.21.0
  - @claudexor/event-log@3.21.0
  - @claudexor/secrets@3.21.0

## 3.20.1

### Patch Changes

- 705c2c1: Preserve received assistant text and cancelled Git effects without changing completion authority or starting another generation. Show retained Markdown beneath the real failure or cancellation cause, recover interrupted output from its existing event log, and bind manual Revert to the captured execution tree.
- Updated dependencies [eb506c1]
- Updated dependencies [dc30eda]
- Updated dependencies [705c2c1]
  - @claudexor/schema@3.20.1
  - @claudexor/event-log@3.20.1
  - @claudexor/delivery@3.20.1
  - @claudexor/workspace@3.20.1
  - @claudexor/secrets@3.20.1
  - @claudexor/util@3.20.1

## 3.20.0

### Patch Changes

- Updated dependencies [c12828c]
  - @claudexor/workspace@3.20.0
  - @claudexor/util@3.20.0
  - @claudexor/delivery@3.20.0
  - @claudexor/event-log@3.20.0
  - @claudexor/schema@3.20.0
  - @claudexor/secrets@3.20.0

## 3.19.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.19.0
  - @claudexor/delivery@3.19.0
  - @claudexor/workspace@3.19.0
  - @claudexor/event-log@3.19.0
  - @claudexor/secrets@3.19.0
  - @claudexor/util@3.19.0

## 3.18.0

### Patch Changes

- @claudexor/delivery@3.18.0
- @claudexor/workspace@3.18.0
- @claudexor/event-log@3.18.0
- @claudexor/schema@3.18.0
- @claudexor/secrets@3.18.0
- @claudexor/util@3.18.0

## 3.17.2

### Patch Changes

- Adapt Codex raw-model Ultra preferences to the strongest supported generation effort in the vendor order, preserve explicit effort evidence, and keep native Ultra delegation unchanged (#368).

- Updated dependencies
  - @claudexor/schema@3.17.2
  - @claudexor/delivery@3.17.2
  - @claudexor/event-log@3.17.2
  - @claudexor/workspace@3.17.2
  - @claudexor/secrets@3.17.2
  - @claudexor/util@3.17.2

## 3.17.1

### Patch Changes

- 72825b9: Resolve effort preferences at the final native route using the strongest supported level at or below a known request, with an explicitly recorded minimum or vendor-default omission when applicable. Preserve advertised future values, original preferences and model identities. Add shared typed effort evidence to model results and final attempt telemetry; keep adaptation disclosures in logs.

  Preserve strict legacy model results unless creation opts into `captureEffortEvidence=true`, binding that choice to idempotency while keeping exact stored bytes and digest acknowledgement. Keep effort verification metadata in negotiated account catalogs only. Refuse unplaceable effort without retrying another route, clean temporary Codex authorization on preparation exit, and describe prepared controls without claiming dispatch.

- Updated dependencies [72825b9]
  - @claudexor/schema@3.17.1
  - @claudexor/delivery@3.17.1
  - @claudexor/event-log@3.17.1
  - @claudexor/workspace@3.17.1
  - @claudexor/secrets@3.17.1
  - @claudexor/util@3.17.1

## 3.17.0

### Patch Changes

- 951489f: `POST /v2/runs` and Exact Retry for a project root that was never registered now answer a typed `404 project_not_registered` (not retryable, with the remedy: register the root with `POST /v2/projects` or declare `scope.ephemeral`) instead of a retryable `503 idempotency_status_unavailable`.
- Updated dependencies [951489f]
  - @claudexor/schema@3.17.0
  - @claudexor/delivery@3.17.0
  - @claudexor/workspace@3.17.0
  - @claudexor/event-log@3.17.0
  - @claudexor/secrets@3.17.0
  - @claudexor/util@3.17.0

## 3.16.0

### Minor Changes

- 788ddca: Add `POST /v2/runs/:id/messages`: a live message into a running run's active attempt with journal-first admission, typed outcomes (delivered, accepted, rejected, not_active, unsupported, delivery_unknown) plus reasons, and a key-required idempotent receipt. Each harness declares its live-input channel as `capability_profile.live_input`, projected as `liveInput` in the agent-capability catalog.

### Patch Changes

- Updated dependencies [788ddca]
  - @claudexor/schema@3.16.0
  - @claudexor/delivery@3.16.0
  - @claudexor/event-log@3.16.0
  - @claudexor/workspace@3.16.0
  - @claudexor/secrets@3.16.0
  - @claudexor/util@3.16.0

## 3.15.1

### Patch Changes

- @claudexor/delivery@3.15.1
- @claudexor/event-log@3.15.1
- @claudexor/schema@3.15.1
- @claudexor/secrets@3.15.1
- @claudexor/util@3.15.1
- @claudexor/workspace@3.15.1

## 3.15.0

### Patch Changes

- @claudexor/delivery@3.15.0
- @claudexor/workspace@3.15.0
- @claudexor/event-log@3.15.0
- @claudexor/schema@3.15.0
- @claudexor/secrets@3.15.0
- @claudexor/util@3.15.0

## 3.14.0

### Patch Changes

- Updated dependencies [2c024ac]
- Updated dependencies [7e615b6]
- Updated dependencies [fb42a94]
  - @claudexor/schema@3.14.0
  - @claudexor/delivery@3.14.0
  - @claudexor/workspace@3.14.0
  - @claudexor/event-log@3.14.0
  - @claudexor/secrets@3.14.0
  - @claudexor/util@3.14.0

## 3.13.0

### Patch Changes

- @claudexor/delivery@3.13.0
- @claudexor/event-log@3.13.0
- @claudexor/schema@3.13.0
- @claudexor/secrets@3.13.0
- @claudexor/util@3.13.0
- @claudexor/workspace@3.13.0

## 3.12.10

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.10
  - @claudexor/delivery@3.12.10
  - @claudexor/event-log@3.12.10
  - @claudexor/workspace@3.12.10
  - @claudexor/secrets@3.12.10
  - @claudexor/util@3.12.10

## 3.12.9

### Patch Changes

- Updated dependencies [125aea9]
  - @claudexor/schema@3.12.9
  - @claudexor/delivery@3.12.9
  - @claudexor/event-log@3.12.9
  - @claudexor/workspace@3.12.9
  - @claudexor/secrets@3.12.9
  - @claudexor/util@3.12.9

## 3.12.8

### Patch Changes

- @claudexor/delivery@3.12.8
- @claudexor/event-log@3.12.8
- @claudexor/schema@3.12.8
- @claudexor/secrets@3.12.8
- @claudexor/util@3.12.8
- @claudexor/workspace@3.12.8

## 3.12.7

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.7
  - @claudexor/delivery@3.12.7
  - @claudexor/event-log@3.12.7
  - @claudexor/workspace@3.12.7
  - @claudexor/secrets@3.12.7
  - @claudexor/util@3.12.7

## 3.12.6

### Patch Changes

- @claudexor/delivery@3.12.6
- @claudexor/event-log@3.12.6
- @claudexor/schema@3.12.6
- @claudexor/secrets@3.12.6
- @claudexor/util@3.12.6
- @claudexor/workspace@3.12.6

## 3.12.5

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.5
  - @claudexor/delivery@3.12.5
  - @claudexor/event-log@3.12.5
  - @claudexor/workspace@3.12.5
  - @claudexor/secrets@3.12.5
  - @claudexor/util@3.12.5

## 3.12.4

### Patch Changes

- @claudexor/delivery@3.12.4
- @claudexor/event-log@3.12.4
- @claudexor/schema@3.12.4
- @claudexor/secrets@3.12.4
- @claudexor/util@3.12.4
- @claudexor/workspace@3.12.4

## 3.12.3

### Patch Changes

- @claudexor/delivery@3.12.3
- @claudexor/event-log@3.12.3
- @claudexor/schema@3.12.3
- @claudexor/secrets@3.12.3
- @claudexor/util@3.12.3
- @claudexor/workspace@3.12.3

## 3.12.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.2
  - @claudexor/delivery@3.12.2
  - @claudexor/event-log@3.12.2
  - @claudexor/workspace@3.12.2
  - @claudexor/secrets@3.12.2
  - @claudexor/util@3.12.2

## 3.12.1

### Patch Changes

- Reading ONE run no longer serializes every retained run. The daemon's retained-command list RPC takes an optional query addressing a single subject (one run id, or one parent's direct Delegate children) and selects before it redacts, so `GET /v2/runs/:id` stops recursively projecting the prompts of unrelated runs; the unqualified read and the global `GET /v2/runs` page are unchanged, and an engine older than the query answers in full so callers keep applying their own selection.
- Updated dependencies
  - @claudexor/schema@3.12.1
  - @claudexor/delivery@3.12.1
  - @claudexor/event-log@3.12.1
  - @claudexor/workspace@3.12.1
  - @claudexor/secrets@3.12.1
  - @claudexor/util@3.12.1

## 3.12.0

### Patch Changes

- Updated dependencies [217d53f]
  - @claudexor/schema@3.12.0
  - @claudexor/delivery@3.12.0
  - @claudexor/event-log@3.12.0
  - @claudexor/workspace@3.12.0
  - @claudexor/secrets@3.12.0
  - @claudexor/util@3.12.0

## 3.11.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.11.0
  - @claudexor/delivery@3.11.0
  - @claudexor/event-log@3.11.0
  - @claudexor/workspace@3.11.0
  - @claudexor/secrets@3.11.0
  - @claudexor/util@3.11.0

## 3.10.5

### Patch Changes

- @claudexor/delivery@3.10.5
- @claudexor/event-log@3.10.5
- @claudexor/schema@3.10.5
- @claudexor/secrets@3.10.5
- @claudexor/util@3.10.5

## 3.10.4

### Patch Changes

- Codex model operations carry the caller's live `x-codex-turn-state` transport continuation on the existing route-bound opaque envelope (opt-in per request, first successful header captured before the body, replayed unchanged on the matching route, empty on a changed route). Attempt telemetry, run telemetry and run summaries gain an additive normalized `input_token_usage` / `inputTokenUsage` object (complete input total, cache reads, cache writes; null stays unknown) folded strictly across contributions; legacy token fields keep their harness-specific meanings.
- Updated dependencies
  - @claudexor/schema@3.10.4
  - @claudexor/delivery@3.10.4
  - @claudexor/event-log@3.10.4
  - @claudexor/secrets@3.10.4
  - @claudexor/util@3.10.4

## 3.10.3

### Patch Changes

- @claudexor/delivery@3.10.3
- @claudexor/event-log@3.10.3
- @claudexor/schema@3.10.3
- @claudexor/secrets@3.10.3
- @claudexor/util@3.10.3

## 3.10.2

### Patch Changes

- Preserve useful contradictory Council drafts as explicitly unverified merger inputs and move journal maintenance after admission, including Windows pending-tail recovery and native coverage.
- Updated dependencies
  - @claudexor/schema@3.10.2
  - @claudexor/delivery@3.10.2
  - @claudexor/event-log@3.10.2
  - @claudexor/secrets@3.10.2
  - @claudexor/util@3.10.2

## 3.10.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.1
  - @claudexor/delivery@3.10.1
  - @claudexor/event-log@3.10.1
  - @claudexor/secrets@3.10.1
  - @claudexor/util@3.10.1

## 3.10.0

### Minor Changes

- Add caller-owned Codex model operations through managed accounts shared with Agents, with exact model payloads, durable single-generation identity, result acknowledgement and typed outcome/cost evidence. Keep system prompts, conversation history and tool execution with the caller. Preserve unconfirmed setup termination during runtime replacement; a pre-permit failure without recorded process evidence remains unreconcilable and is disclosed rather than introducing a new journal format. Simplify contributor release review while retaining signed runtime manifests and exact candidate promotion.

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.0
  - @claudexor/delivery@3.10.0
  - @claudexor/event-log@3.10.0
  - @claudexor/secrets@3.10.0
  - @claudexor/util@3.10.0

## 3.9.8

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.8
  - @claudexor/delivery@3.9.8
  - @claudexor/event-log@3.9.8
  - @claudexor/secrets@3.9.8
  - @claudexor/util@3.9.8

## 3.9.7

### Patch Changes

- @claudexor/delivery@3.9.7
- @claudexor/event-log@3.9.7
- @claudexor/schema@3.9.7
- @claudexor/secrets@3.9.7
- @claudexor/util@3.9.7

## 3.9.6

### Patch Changes

- @claudexor/delivery@3.9.6
- @claudexor/event-log@3.9.6
- @claudexor/schema@3.9.6
- @claudexor/secrets@3.9.6
- @claudexor/util@3.9.6

## 3.9.5

### Patch Changes

- @claudexor/delivery@3.9.5
- @claudexor/event-log@3.9.5
- @claudexor/schema@3.9.5
- @claudexor/secrets@3.9.5
- @claudexor/util@3.9.5

## 3.9.4

### Patch Changes

- @claudexor/delivery@3.9.4
- @claudexor/event-log@3.9.4
- @claudexor/schema@3.9.4
- @claudexor/secrets@3.9.4
- @claudexor/util@3.9.4

## 3.9.3

### Patch Changes

- Preserve typed text-fragment metadata in delegated run timelines so hosts can join streamed words and whitespace without inserting event separators. Keep complete messages, tool events, final answers, and omission disclosures distinct.

  Allow release review by any two distinct approved model families on any harness, recording the actual model and harness while retaining exact-candidate evidence, independent reports, and signed attestation checks.

- Updated dependencies
  - @claudexor/schema@3.9.3
  - @claudexor/delivery@3.9.3
  - @claudexor/event-log@3.9.3
  - @claudexor/secrets@3.9.3
  - @claudexor/util@3.9.3

## 3.9.2

### Patch Changes

- @claudexor/delivery@3.9.2
- @claudexor/event-log@3.9.2
- @claudexor/schema@3.9.2
- @claudexor/secrets@3.9.2
- @claudexor/util@3.9.2

## 3.9.1

### Patch Changes

- @claudexor/delivery@3.9.1
- @claudexor/event-log@3.9.1
- @claudexor/schema@3.9.1
- @claudexor/secrets@3.9.1
- @claudexor/util@3.9.1

## 3.9.0

### Patch Changes

- Updated dependencies [d9cccac]
- Updated dependencies [69500f8]
- Updated dependencies [e39c57b]
- Updated dependencies [fd623ff]
- Updated dependencies [278e436]
  - @claudexor/schema@3.9.0
  - @claudexor/delivery@3.9.0
  - @claudexor/event-log@3.9.0
  - @claudexor/secrets@3.9.0
  - @claudexor/util@3.9.0

## 3.8.4

### Patch Changes

- @claudexor/delivery@3.8.4
- @claudexor/event-log@3.8.4
- @claudexor/schema@3.8.4
- @claudexor/secrets@3.8.4
- @claudexor/util@3.8.4

## 3.8.3

### Patch Changes

- @claudexor/delivery@3.8.3
- @claudexor/event-log@3.8.3
- @claudexor/schema@3.8.3
- @claudexor/secrets@3.8.3
- @claudexor/util@3.8.3

## 3.8.2

### Patch Changes

- @claudexor/delivery@3.8.2
- @claudexor/event-log@3.8.2
- @claudexor/schema@3.8.2
- @claudexor/secrets@3.8.2
- @claudexor/util@3.8.2

## 3.8.1

### Patch Changes

- 2794ec7: Remove the engine-owned outer Seatbelt wrapper and restore each harness's
  native access policy. Delegated mutating runs now keep stable project identity
  separate from their disposable execution workspace, active requests use
  `readonly`, `workspace_write`, or explicitly trusted `full`, and historical
  outer-confinement artifacts remain readable without enabling new retired-mode
  runs.
- Updated dependencies [ce6dba1]
- Updated dependencies [2794ec7]
  - @claudexor/schema@3.8.1
  - @claudexor/util@3.8.1
  - @claudexor/delivery@3.8.1
  - @claudexor/event-log@3.8.1
  - @claudexor/secrets@3.8.1

## 3.8.0

### Patch Changes

- Updated dependencies [6054b7d]
  - @claudexor/schema@3.8.0
  - @claudexor/delivery@3.8.0
  - @claudexor/event-log@3.8.0
  - @claudexor/secrets@3.8.0
  - @claudexor/util@3.8.0

## 3.7.0

### Patch Changes

- @claudexor/delivery@3.7.0
- @claudexor/event-log@3.7.0
- @claudexor/schema@3.7.0
- @claudexor/secrets@3.7.0
- @claudexor/util@3.7.0

## 3.6.0

### Minor Changes

- 895967f: Unified account model (INV-135 rewrite, owner-approved). Every account is a
  named registry row — the separate "default"/"CLI login" account type is gone.
  A detected legacy claude/codex default-store login auto-registers at daemon
  start as the ordinary `<harness>-default` row through a crash-recoverable
  migration (typed per-harness run refusal while incomplete; rollback command
  as the supported downgrade path). Unpinned runs route through a quota-aware
  pool of enabled+ready rows with sticky, disclosed thread bindings; explicit
  pins are strict (typed `subscription_window_exhausted` refusal, no silent
  rotation); pool exhaustion is a typed `credential_pool_exhausted` terminal
  carrying the pool's earliest known reset, and the paid API-key route serves
  it only under the explicit `api_key` preference — never silently under
  `auto` (owner Q3=A). New wire: additive `accountPools` pool
  authority plus `GET /v2/account-pools` (the feature marker) and
  `POST /v2/accounts-migration/rollback`; `harnessAccounts` stays on the wire
  as `[]` for legacy strict clients. Cursor host-Keychain logins are retired:
  every cursor account lives in an isolated vendor file-store row, and
  `auth login` becomes bootstrap sugar into the `<harness>-default` row.
  Deleting a row is provable (typed retryable error on partial cleanup) and
  retires migrated legacy aliases in the same operation.

### Patch Changes

- Updated dependencies [895967f]
  - @claudexor/schema@3.6.0
  - @claudexor/delivery@3.6.0
  - @claudexor/event-log@3.6.0
  - @claudexor/secrets@3.6.0
  - @claudexor/util@3.6.0

## 3.5.0

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/util@3.5.0
  - @claudexor/delivery@3.5.0
  - @claudexor/event-log@3.5.0
  - @claudexor/schema@3.5.0
  - @claudexor/secrets@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/delivery@3.4.2
- @claudexor/event-log@3.4.2
- @claudexor/schema@3.4.2
- @claudexor/secrets@3.4.2
- @claudexor/util@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/delivery@3.4.1
- @claudexor/event-log@3.4.1
- @claudexor/schema@3.4.1
- @claudexor/secrets@3.4.1
- @claudexor/util@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/delivery@3.4.0
- @claudexor/event-log@3.4.0
- @claudexor/schema@3.4.0
- @claudexor/secrets@3.4.0
- @claudexor/util@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/delivery@3.3.16
- @claudexor/event-log@3.3.16
- @claudexor/schema@3.3.16
- @claudexor/secrets@3.3.16
- @claudexor/util@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/delivery@3.3.15
- @claudexor/event-log@3.3.15
- @claudexor/schema@3.3.15
- @claudexor/secrets@3.3.15
- @claudexor/util@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/delivery@3.3.14
- @claudexor/event-log@3.3.14
- @claudexor/schema@3.3.14
- @claudexor/secrets@3.3.14
- @claudexor/util@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/delivery@3.3.13
- @claudexor/event-log@3.3.13
- @claudexor/schema@3.3.13
- @claudexor/secrets@3.3.13
- @claudexor/util@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/delivery@3.3.12
- @claudexor/event-log@3.3.12
- @claudexor/schema@3.3.12
- @claudexor/secrets@3.3.12
- @claudexor/util@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/delivery@3.3.0
- @claudexor/event-log@3.3.0
- @claudexor/schema@3.3.0
- @claudexor/secrets@3.3.0
- @claudexor/util@3.3.0

## 3.2.1

### Patch Changes

- @claudexor/delivery@3.2.1
- @claudexor/event-log@3.2.1
- @claudexor/schema@3.2.1
- @claudexor/secrets@3.2.1
- @claudexor/util@3.2.1

## 3.2.0

### Patch Changes

- Preserve typed run applicability, Git capability, safe durable refusal context and exact retry remedies, and one canonical terminal presentation across control projections.
- Preserve the deciding credential profile when projecting telemetry auth-route receipts.
- Keep upload, project, and retention request, service, and response failures distinct; malformed service responses now fail closed against their public schemas.
- Fence stale runless-turn replays across ordinary turns, Exact Retry, and
  decision reruns; preserve Exact Retry plan provenance and replay recorded
  risk decisions before a later turn's idle gate.
- @claudexor/delivery@3.2.0
- @claudexor/event-log@3.2.0
- @claudexor/schema@3.2.0
- @claudexor/secrets@3.2.0
- @claudexor/util@3.2.0

## 3.1.2

### Patch Changes

- Restore Delegate in packaged installs through the exact daemon self-entry; enforce required MCP startup, bounded shared parent/child budget and cancellation authority, typed lineage and degradation receipts, and durable CLI/macOS projections across reload and reconnect.
- Updated dependencies
  - @claudexor/event-log@3.1.2
  - @claudexor/schema@3.1.2
  - @claudexor/delivery@3.1.2
  - @claudexor/secrets@3.1.2
  - @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- Exact retry on a pre-start terminal run answers with its typed refusal (a 403,
  not a 202 handle), and the CLI retry and run-again paths read the refusal's
  actual problem message instead of an `error` field the daemon never serves.
- Updated dependencies
  - @claudexor/schema@3.1.1
  - @claudexor/delivery@3.1.1
  - @claudexor/event-log@3.1.1
  - @claudexor/secrets@3.1.1
  - @claudexor/util@3.1.1

## 3.1.0

### Minor Changes

- c3b7ece: Support declared JSON Schema draft-07 and draft 2020-12 output contracts, publish the supported dialect catalog, and record the selected dialect plus stable schema hash in structured-output receipts. Local JSON Pointer references are inlined only for native provider transport while the original schema remains the validation authority.

### Patch Changes

- Updated dependencies [c3b7ece]
  - @claudexor/schema@3.1.0
  - @claudexor/delivery@3.1.0
  - @claudexor/event-log@3.1.0
  - @claudexor/secrets@3.1.0
  - @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/delivery@3.0.3
- @claudexor/event-log@3.0.3
- @claudexor/schema@3.0.3
- @claudexor/secrets@3.0.3
- @claudexor/util@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/delivery@3.0.0
- @claudexor/event-log@3.0.0
- @claudexor/schema@3.0.0
- @claudexor/secrets@3.0.0
- @claudexor/util@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/delivery@2.1.3
- @claudexor/event-log@2.1.3
- @claudexor/schema@2.1.3
- @claudexor/secrets@2.1.3
- @claudexor/util@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/delivery@2.1.2
- @claudexor/event-log@2.1.2
- @claudexor/schema@2.1.2
- @claudexor/secrets@2.1.2
- @claudexor/util@2.1.2

## 2.1.1

### Patch Changes

- @claudexor/delivery@2.1.1
- @claudexor/event-log@2.1.1
- @claudexor/schema@2.1.1
- @claudexor/secrets@2.1.1
- @claudexor/util@2.1.1

## 2.1.0

### Minor Changes

- Claudexor 2.1.0: credential profiles (INV-135). Multiple subscriptions per
  harness with isolated vendor config dirs and namespaced secret slots; strict
  per-turn / thread-sticky selection with profile-isolated native-session
  resume; per-profile doctor probes and proactive per-profile subscription
  quota from the vendor oauth/usage endpoint; one typed profile policy per
  harness with provenance-recorded rotation on typed vendor-limit evidence
  only. Includes the unpublished 2.0.1 honest-engine and 2.0.2 simple-UI
  passes.

### Patch Changes

- 0fc050b: Credential profiles (INV-135): durable non-secret `credential_profiles`
  registry in the global config; the orchestrator resolves an explicit per-run
  profile id ONCE and stamps the typed profile on every HarnessRunSpec; adapters
  consume exactly the profile's transport (claude config-dir login / non-bare
  token / key; codex scoped CODEX_HOME / scoped auth.json; cursor, opencode,
  raw-api secret-ref keys) or refuse typed — never a fallback to default
  credentials. Namespaced secret slots (`claude_oauth:<profile>`), per-profile
  doctor probes (`GET /credential-profiles`, `claudexor profiles`), interactive
  `claudexor profiles login`, profile-stamped route evidence, and
  profile-isolated native-session resume.
- Updated dependencies
- Updated dependencies [0fc050b]
  - @claudexor/schema@2.1.0
  - @claudexor/secrets@2.1.0
  - @claudexor/delivery@2.1.0
  - @claudexor/event-log@2.1.0
  - @claudexor/util@2.1.0

## 2.0.2

### Patch Changes

- @claudexor/delivery@2.0.2
- @claudexor/event-log@2.0.2
- @claudexor/schema@2.0.2
- @claudexor/secrets@2.0.2
- @claudexor/util@2.0.2

## 2.0.1

### Patch Changes

- @claudexor/delivery@2.0.1
- @claudexor/event-log@2.0.1
- @claudexor/schema@2.0.1
- @claudexor/secrets@2.0.1
- @claudexor/util@2.0.1

## 2.0.0

### Patch Changes

- @claudexor/delivery@2.0.0
- @claudexor/event-log@2.0.0
- @claudexor/schema@2.0.0
- @claudexor/secrets@2.0.0
- @claudexor/util@2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

### Patch Changes

- Stabilize the checkpoint release with explicit reviewer-panel hardening, mandatory
  review evidence preflight, scoped Cursor reviewer readiness, frozen SpecPack gate
  merging, protected-path approvals, and thin control/macOS projection parity.
- Updated dependencies
  - @claudexor/schema@0.14.1
  - @claudexor/delivery@0.14.1
  - @claudexor/event-log@0.14.1
  - @claudexor/util@0.14.1

## 0.14.0

### Patch Changes

- @claudexor/delivery@0.14.0
- @claudexor/event-log@0.14.0
- @claudexor/schema@0.14.0
- @claudexor/util@0.14.0

## 0.13.3

### Patch Changes

- @claudexor/delivery@0.13.3
- @claudexor/event-log@0.13.3
- @claudexor/schema@0.13.3
- @claudexor/util@0.13.3

## 0.12.1

### Patch Changes

- @claudexor/delivery@0.12.1
- @claudexor/event-log@0.12.1
- @claudexor/schema@0.12.1
- @claudexor/util@0.12.1
