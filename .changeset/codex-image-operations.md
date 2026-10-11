---
"@claudexor/schema": minor
"@claudexor/core": minor
"@claudexor/budget": minor
"@claudexor/daemon": minor
"@claudexor/control-api": minor
"@claudexor/harness-codex": minor
"@claudexor/orchestrator": minor
"@claudexor/cli": minor
---

Generate and edit images through subscription-backed Codex accounts as a payload kind of the existing caller-owned model operations. Upload an `ImageCallRequest` with `purpose: "model"` and create it with `POST /v2/model-operations?requestKind=image` (omission stays text): the same idempotency key, queue, SQL flush barrier before the provider request, cancellation, private result with 30-day unacknowledged retention and whole-result digest ACK serve both kinds, with no second scheduler and no subscription-to-API fallback. A failed barrier or a cancellation before the request reports that nothing was sent. `ImageCallResult` keeps the requested model apart from the provider-observed route model, the applied options, reported usage, unknown cash and every usable image with its verified MIME, size and digest; rejected siblings are named in the problem context instead of discarding the good ones. `GET /v2/model-sources?view=accounts` declares the source's structural `imageGeneration` facet, whose model ids are presence hints, not an entitlement. Quota constraints may declare `applies_to_request_kinds` (absent applies to both kinds): Codex `codex`/`default` windows are text and `image_gen` is image, an image 429 with an observed reset enters the registry as image-only evidence, and `GET /v2/quota` (including its resources and constraint-freshness views) and `POST /v2/quota` accept optional `requestKind` and `model`. Image windows stay visible in Accounts, labelled, but no longer drive text availability, the compact text percentage, the cooldown badge or a run's quota-pressure disclosure; legacy unscoped windows keep applying to both kinds until a newer measured scoped read replaces them. Live proof covers one generation and one edit through the real adapter on one managed account before the SQL store; SQL custody is covered by real-store tests over a synthetic endpoint, and other accounts' entitlement, image quota headers and the released live chain remain unverified. Thanks to @josephsteuerjr for the original image-operations contribution (#428).
