# @claudexor/review

## 4.7.0

### Patch Changes

- Updated dependencies [74fb275]
  - @claudexor/schema@4.7.0
  - @claudexor/core@4.7.0
  - @claudexor/workspace@4.7.0
  - @claudexor/budget@4.7.0
  - @claudexor/config@4.7.0
  - @claudexor/context@4.7.0
  - @claudexor/util@4.7.0

## 4.6.2

### Patch Changes

- @claudexor/budget@4.6.2
- @claudexor/config@4.6.2
- @claudexor/context@4.6.2
- @claudexor/core@4.6.2
- @claudexor/schema@4.6.2
- @claudexor/util@4.6.2
- @claudexor/workspace@4.6.2

## 4.6.1

### Patch Changes

- @claudexor/budget@4.6.1
- @claudexor/config@4.6.1
- @claudexor/context@4.6.1
- @claudexor/core@4.6.1
- @claudexor/schema@4.6.1
- @claudexor/util@4.6.1
- @claudexor/workspace@4.6.1

## 4.6.0

### Minor Changes

- a81897c: Choose the native prompt-cache lifetime of Claude Code sessions per run: `POST /v2/runs` and `POST /v2/threads/:id/turns` accept `promptCacheTtl: "5m" | "1h"` (CLI `--prompt-cache-ttl`, including plan answers the same command submits inline), and omission keeps native defaults, profile settings and the inherited environment. Adapters declare the values they translate in `capability_profile.prompt_cache_ttls`; `GET /v2/agent-capabilities` projects them as `harnesses[].promptCacheTtls` and lists the key in `runControlKeys`. The value is frozen into the task contract, inherited by a bare `continueFrom` (a successor cannot go back to Default; that takes a new run), re-injected by Exact Retry, and forwarded to task lanes, the continuity summary, reviewers and delegation-belt children on declaring harnesses. Elsewhere it is an `ignored_settings` disclosure, except in best-of synthesis, which emits no `harness.started`: an undeclared synthesis harness runs without the lifetime and without a disclosure. The deep-scan reducer's `harness.started` now discloses every route knob its harness ignores, including `max_turns` and tool lists. The Claude adapter sets `CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, keeps forcing and disabling controls, and discloses the ones known to govern instead (and a known older CLI). Each Claude attempt records `prompt_cache_ttl` in `final/telemetry.yaml` with the lifetime routed to its sessions (`requested`), the configured value and the observed split of the reported five-minute and one-hour cache-write tokens; an unreported split stays unknown.

### Patch Changes

- 2593b90: On Windows, background harness runs and captures start the vendor with an invisible
  console instead of none, so the shells, `git`, MCP servers and other console programs
  a run starts inherit it instead of opening windows of their own. Agy keeps the
  console-less start because its print mode treats an openable console input as
  interactive, and Claudexor's own `git` calls keep the console-less start they always
  had.
  Cancellation still stops the whole tree with `taskkill /T`, and a background child
  now also ends when the daemon process dies. The no-Terminal sign-in
  children (URL disclosure and the device-code app-server) open no console window, and
  Codex quota and model discovery, the install version proof and the `login --help`
  probe start their direct child hidden. The Node preload that defaulted `windowsHide`
  inside npm wrappers is removed: the inherited console covers those children.
- Updated dependencies [b344c39]
- Updated dependencies [a81897c]
- Updated dependencies [2593b90]
  - @claudexor/core@4.6.0
  - @claudexor/schema@4.6.0
  - @claudexor/util@4.6.0
  - @claudexor/context@4.6.0
  - @claudexor/workspace@4.6.0
  - @claudexor/budget@4.6.0
  - @claudexor/config@4.6.0

## 4.5.0

### Patch Changes

- Updated dependencies [032b44b]
- Updated dependencies [85e312d]
  - @claudexor/schema@4.5.0
  - @claudexor/workspace@4.5.0
  - @claudexor/budget@4.5.0
  - @claudexor/config@4.5.0
  - @claudexor/context@4.5.0
  - @claudexor/core@4.5.0
  - @claudexor/util@4.5.0

## 4.4.0

### Patch Changes

- Updated dependencies
  - @claudexor/util@4.4.0
  - @claudexor/schema@4.4.0
  - @claudexor/budget@4.4.0
  - @claudexor/config@4.4.0
  - @claudexor/context@4.4.0
  - @claudexor/core@4.4.0
  - @claudexor/workspace@4.4.0

## 4.3.1

### Patch Changes

- Updated dependencies [64ee7fc]
  - @claudexor/workspace@4.3.1
  - @claudexor/budget@4.3.1
  - @claudexor/config@4.3.1
  - @claudexor/context@4.3.1
  - @claudexor/core@4.3.1
  - @claudexor/schema@4.3.1
  - @claudexor/util@4.3.1

## 4.3.0

### Minor Changes

- Ordinary Codex Fast (`fast`/`priority`) on a verified ChatGPT subscription is included service under no-paid routing and every cash cap, including `finite(0)`; verified Codex subscription work now reports its cash as unknown (`spendUsd` and `budget_summary.spend_usd` null, cost basis `debit: "unobserved"`) beside the cap-governed `controllableSpendUsd` instead of exact zero, and without a preference keeps the first account's chosen speed across retries, Exact Retry, rotation and continuation (#468, thanks @IlidanNaga). Codex catalogs keep a declared `inputModalities` list only when it is wholly valid and non-empty, as metadata that gates no request (#435, thanks @josephsteuerjr). The opt-in `GET /v2/quota?view=resources_freshness` view adds a required `availability_scope` echo, Cursor accounts report dated display-only monetary resources from Cursor's internal dashboard through the existing refresh cycle, and Antigravity's native headless permission auto-denial becomes typed `permission_denial` evidence without retry or access elevation (#467).

  Codex workspace-write uses native on-request with auto_review by default and an explicit one-action retry handback; HTTP/MCP can revise the existing live soft/hard timer, and configuration can disable only inactivity timing with null (#466, thanks @IlidanNaga). This adds no session-wide grant, readonly bypass, automatic retry authorization by Claudexor, per-run idle field or installed CLI update; timers are not restored after daemon loss and native UI/vendor qualification remains limited.

### Patch Changes

- Updated dependencies
- Updated dependencies [23a74cb]
  - @claudexor/budget@4.3.0
  - @claudexor/core@4.3.0
  - @claudexor/schema@4.3.0
  - @claudexor/config@4.3.0
  - @claudexor/context@4.3.0
  - @claudexor/workspace@4.3.0
  - @claudexor/util@4.3.0

## 4.2.0

### Patch Changes

- @claudexor/budget@4.2.0
- @claudexor/config@4.2.0
- @claudexor/context@4.2.0
- @claudexor/core@4.2.0
- @claudexor/schema@4.2.0
- @claudexor/util@4.2.0
- @claudexor/workspace@4.2.0

## 4.1.1

### Patch Changes

- @claudexor/budget@4.1.1
- @claudexor/config@4.1.1
- @claudexor/context@4.1.1
- @claudexor/core@4.1.1
- @claudexor/schema@4.1.1
- @claudexor/util@4.1.1
- @claudexor/workspace@4.1.1

## 4.1.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@4.1.0
  - @claudexor/core@4.1.0
  - @claudexor/budget@4.1.0
  - @claudexor/config@4.1.0
  - @claudexor/context@4.1.0
  - @claudexor/workspace@4.1.0
  - @claudexor/util@4.1.0

## 4.0.1

### Patch Changes

- @claudexor/budget@4.0.1
- @claudexor/config@4.0.1
- @claudexor/context@4.0.1
- @claudexor/core@4.0.1
- @claudexor/schema@4.0.1
- @claudexor/util@4.0.1
- @claudexor/workspace@4.0.1

## 4.0.0

### Patch Changes

- Updated dependencies [2fbf7c9]
  - @claudexor/schema@4.0.0
  - @claudexor/util@4.0.0
  - @claudexor/config@4.0.0
  - @claudexor/budget@4.0.0
  - @claudexor/context@4.0.0
  - @claudexor/core@4.0.0
  - @claudexor/workspace@4.0.0

## 3.25.1

### Patch Changes

- @claudexor/budget@3.25.1
- @claudexor/config@3.25.1
- @claudexor/context@3.25.1
- @claudexor/core@3.25.1
- @claudexor/schema@3.25.1
- @claudexor/util@3.25.1
- @claudexor/workspace@3.25.1

## 3.25.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.25.0
  - @claudexor/budget@3.25.0
  - @claudexor/config@3.25.0
  - @claudexor/context@3.25.0
  - @claudexor/core@3.25.0
  - @claudexor/workspace@3.25.0
  - @claudexor/util@3.25.0

## 3.24.0

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.24.0
  - @claudexor/schema@3.24.0
  - @claudexor/context@3.24.0
  - @claudexor/workspace@3.24.0
  - @claudexor/budget@3.24.0
  - @claudexor/config@3.24.0
  - @claudexor/util@3.24.0

## 3.23.2

### Patch Changes

- @claudexor/budget@3.23.2
- @claudexor/config@3.23.2
- @claudexor/context@3.23.2
- @claudexor/core@3.23.2
- @claudexor/schema@3.23.2
- @claudexor/util@3.23.2
- @claudexor/workspace@3.23.2

## 3.23.1

### Patch Changes

- @claudexor/budget@3.23.1
- @claudexor/config@3.23.1
- @claudexor/context@3.23.1
- @claudexor/core@3.23.1
- @claudexor/schema@3.23.1
- @claudexor/util@3.23.1
- @claudexor/workspace@3.23.1

## 3.23.0

### Patch Changes

- @claudexor/budget@3.23.0
- @claudexor/config@3.23.0
- @claudexor/context@3.23.0
- @claudexor/core@3.23.0
- @claudexor/schema@3.23.0
- @claudexor/util@3.23.0
- @claudexor/workspace@3.23.0

## 3.22.1

### Patch Changes

- Updated dependencies [902532e]
  - @claudexor/schema@3.22.1
  - @claudexor/util@3.22.1
  - @claudexor/budget@3.22.1
  - @claudexor/config@3.22.1
  - @claudexor/context@3.22.1
  - @claudexor/core@3.22.1
  - @claudexor/workspace@3.22.1

## 3.22.0

### Patch Changes

- Updated dependencies [51578d4]
- Updated dependencies [785bba7]
  - @claudexor/schema@3.22.0
  - @claudexor/workspace@3.22.0
  - @claudexor/core@3.22.0
  - @claudexor/budget@3.22.0
  - @claudexor/config@3.22.0
  - @claudexor/context@3.22.0
  - @claudexor/util@3.22.0

## 3.21.0

### Patch Changes

- 7c541ba: One effort word now works on Cursor and Antigravity too, where the level is a token of the compound model id. Given an effort preference, the adapter's preparation selects the listed level variant of the requested model's family from the inventory of the account that will run (`grok-4.7-high` + `max` runs the listed `grok-4.7-xhigh`; `gemini-3.8-flash-low` + `max` runs `gemini-3.8-flash-high`): the family is the id with exactly one shared-order level token removed, `fast` and `thinking` stay in the family key so the choice never crosses fast/standard or thinking/no-thinking, a family exists only when the account lists two or more levels, and the level is placed by the shared preference order alone. One preparation yields the final id (the processing receipt's `submittedNative`, which is the `--model` argument) and the effort receipt (`parameter: --model`, `submitted` = level token), recorded once per spawn and per reviewer dispatch; the requested id stays in the model hint and in `attempts[].requested_model`. Nothing new refuses: an unknown word, an ambiguous id, a family-less id or an empty account list keep the id unchanged with an `omitted` receipt and a note. Antigravity rewrites only from the pinned account's live `agy models` list; the static hint list never authorizes a rewrite. Settings writes accept the preference for these routes, the existing fast-pair and paid policy run after the level choice, and the final telemetry `model_mismatch` compares the observation with the id actually sent.
- Updated dependencies [7c541ba]
- Updated dependencies [f0ab916]
- Updated dependencies [83bc0da]
- Updated dependencies [9ccd45d]
- Updated dependencies [a4ff572]
  - @claudexor/core@3.21.0
  - @claudexor/schema@3.21.0
  - @claudexor/util@3.21.0
  - @claudexor/workspace@3.21.0
  - @claudexor/budget@3.21.0
  - @claudexor/context@3.21.0
  - @claudexor/config@3.21.0

## 3.20.1

### Patch Changes

- eb506c1: Keep account refusal and recovery evidence consistent across execution, account selection and Accounts, with managed credential generations protecting newer state from late results. Preserve independently measured Claude Code and Codex quota windows from running sessions without treating partial observations as a complete refresh. Retain safe native refusal and refresh diagnostics.
- Updated dependencies [eb506c1]
- Updated dependencies [dc30eda]
- Updated dependencies [705c2c1]
  - @claudexor/schema@3.20.1
  - @claudexor/core@3.20.1
  - @claudexor/budget@3.20.1
  - @claudexor/config@3.20.1
  - @claudexor/context@3.20.1
  - @claudexor/workspace@3.20.1
  - @claudexor/util@3.20.1

## 3.20.0

### Patch Changes

- Updated dependencies [c12828c]
  - @claudexor/core@3.20.0
  - @claudexor/workspace@3.20.0
  - @claudexor/util@3.20.0
  - @claudexor/context@3.20.0
  - @claudexor/budget@3.20.0
  - @claudexor/config@3.20.0
  - @claudexor/schema@3.20.0

## 3.19.0

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.19.0
  - @claudexor/config@3.19.0
  - @claudexor/schema@3.19.0
  - @claudexor/context@3.19.0
  - @claudexor/workspace@3.19.0
  - @claudexor/budget@3.19.0
  - @claudexor/util@3.19.0

## 3.18.0

### Patch Changes

- Updated dependencies [b00408e]
  - @claudexor/core@3.18.0
  - @claudexor/context@3.18.0
  - @claudexor/workspace@3.18.0
  - @claudexor/budget@3.18.0
  - @claudexor/config@3.18.0
  - @claudexor/schema@3.18.0
  - @claudexor/util@3.18.0

## 3.17.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.17.2
  - @claudexor/budget@3.17.2
  - @claudexor/config@3.17.2
  - @claudexor/context@3.17.2
  - @claudexor/core@3.17.2
  - @claudexor/workspace@3.17.2
  - @claudexor/util@3.17.2

## 3.17.1

### Patch Changes

- Updated dependencies [72825b9]
  - @claudexor/schema@3.17.1
  - @claudexor/core@3.17.1
  - @claudexor/budget@3.17.1
  - @claudexor/config@3.17.1
  - @claudexor/context@3.17.1
  - @claudexor/workspace@3.17.1
  - @claudexor/util@3.17.1

## 3.17.0

### Patch Changes

- Updated dependencies [092ec2b]
- Updated dependencies [951489f]
  - @claudexor/core@3.17.0
  - @claudexor/schema@3.17.0
  - @claudexor/context@3.17.0
  - @claudexor/workspace@3.17.0
  - @claudexor/budget@3.17.0
  - @claudexor/config@3.17.0
  - @claudexor/util@3.17.0

## 3.16.0

### Patch Changes

- Updated dependencies [788ddca]
  - @claudexor/schema@3.16.0
  - @claudexor/budget@3.16.0
  - @claudexor/config@3.16.0
  - @claudexor/context@3.16.0
  - @claudexor/core@3.16.0
  - @claudexor/workspace@3.16.0
  - @claudexor/util@3.16.0

## 3.15.1

### Patch Changes

- @claudexor/budget@3.15.1
- @claudexor/config@3.15.1
- @claudexor/context@3.15.1
- @claudexor/core@3.15.1
- @claudexor/schema@3.15.1
- @claudexor/util@3.15.1
- @claudexor/workspace@3.15.1

## 3.15.0

### Patch Changes

- Updated dependencies [3bc8af4]
  - @claudexor/core@3.15.0
  - @claudexor/context@3.15.0
  - @claudexor/workspace@3.15.0
  - @claudexor/budget@3.15.0
  - @claudexor/config@3.15.0
  - @claudexor/schema@3.15.0
  - @claudexor/util@3.15.0

## 3.14.0

### Patch Changes

- Updated dependencies [2c024ac]
- Updated dependencies [7e615b6]
- Updated dependencies [fb42a94]
  - @claudexor/core@3.14.0
  - @claudexor/schema@3.14.0
  - @claudexor/context@3.14.0
  - @claudexor/workspace@3.14.0
  - @claudexor/budget@3.14.0
  - @claudexor/config@3.14.0
  - @claudexor/util@3.14.0

## 3.13.0

### Patch Changes

- @claudexor/budget@3.13.0
- @claudexor/config@3.13.0
- @claudexor/context@3.13.0
- @claudexor/core@3.13.0
- @claudexor/schema@3.13.0
- @claudexor/util@3.13.0
- @claudexor/workspace@3.13.0

## 3.12.10

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.10
  - @claudexor/core@3.12.10
  - @claudexor/budget@3.12.10
  - @claudexor/config@3.12.10
  - @claudexor/context@3.12.10
  - @claudexor/workspace@3.12.10
  - @claudexor/util@3.12.10

## 3.12.9

### Patch Changes

- Updated dependencies [125aea9]
  - @claudexor/schema@3.12.9
  - @claudexor/core@3.12.9
  - @claudexor/budget@3.12.9
  - @claudexor/config@3.12.9
  - @claudexor/context@3.12.9
  - @claudexor/workspace@3.12.9
  - @claudexor/util@3.12.9

## 3.12.8

### Patch Changes

- @claudexor/budget@3.12.8
- @claudexor/config@3.12.8
- @claudexor/context@3.12.8
- @claudexor/core@3.12.8
- @claudexor/schema@3.12.8
- @claudexor/util@3.12.8
- @claudexor/workspace@3.12.8

## 3.12.7

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.7
  - @claudexor/budget@3.12.7
  - @claudexor/config@3.12.7
  - @claudexor/context@3.12.7
  - @claudexor/core@3.12.7
  - @claudexor/workspace@3.12.7
  - @claudexor/util@3.12.7

## 3.12.6

### Patch Changes

- @claudexor/budget@3.12.6
- @claudexor/config@3.12.6
- @claudexor/context@3.12.6
- @claudexor/core@3.12.6
- @claudexor/schema@3.12.6
- @claudexor/util@3.12.6
- @claudexor/workspace@3.12.6

## 3.12.5

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.5
  - @claudexor/budget@3.12.5
  - @claudexor/config@3.12.5
  - @claudexor/context@3.12.5
  - @claudexor/core@3.12.5
  - @claudexor/workspace@3.12.5
  - @claudexor/util@3.12.5

## 3.12.4

### Patch Changes

- @claudexor/budget@3.12.4
- @claudexor/config@3.12.4
- @claudexor/context@3.12.4
- @claudexor/core@3.12.4
- @claudexor/schema@3.12.4
- @claudexor/util@3.12.4
- @claudexor/workspace@3.12.4

## 3.12.3

### Patch Changes

- @claudexor/budget@3.12.3
- @claudexor/config@3.12.3
- @claudexor/context@3.12.3
- @claudexor/core@3.12.3
- @claudexor/schema@3.12.3
- @claudexor/util@3.12.3
- @claudexor/workspace@3.12.3

## 3.12.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.2
  - @claudexor/budget@3.12.2
  - @claudexor/config@3.12.2
  - @claudexor/context@3.12.2
  - @claudexor/core@3.12.2
  - @claudexor/workspace@3.12.2
  - @claudexor/util@3.12.2

## 3.12.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.1
  - @claudexor/budget@3.12.1
  - @claudexor/config@3.12.1
  - @claudexor/context@3.12.1
  - @claudexor/core@3.12.1
  - @claudexor/workspace@3.12.1
  - @claudexor/util@3.12.1

## 3.12.0

### Patch Changes

- Updated dependencies [217d53f]
  - @claudexor/schema@3.12.0
  - @claudexor/budget@3.12.0
  - @claudexor/config@3.12.0
  - @claudexor/context@3.12.0
  - @claudexor/core@3.12.0
  - @claudexor/workspace@3.12.0
  - @claudexor/util@3.12.0

## 3.11.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.11.0
  - @claudexor/budget@3.11.0
  - @claudexor/config@3.11.0
  - @claudexor/context@3.11.0
  - @claudexor/core@3.11.0
  - @claudexor/workspace@3.11.0
  - @claudexor/util@3.11.0

## 3.10.5

### Patch Changes

- @claudexor/config@3.10.5
- @claudexor/context@3.10.5
- @claudexor/core@3.10.5
- @claudexor/schema@3.10.5
- @claudexor/util@3.10.5
- @claudexor/workspace@3.10.5

## 3.10.4

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.4
  - @claudexor/config@3.10.4
  - @claudexor/context@3.10.4
  - @claudexor/core@3.10.4
  - @claudexor/workspace@3.10.4
  - @claudexor/util@3.10.4

## 3.10.3

### Patch Changes

- @claudexor/config@3.10.3
- @claudexor/context@3.10.3
- @claudexor/core@3.10.3
- @claudexor/schema@3.10.3
- @claudexor/util@3.10.3
- @claudexor/workspace@3.10.3

## 3.10.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.2
  - @claudexor/config@3.10.2
  - @claudexor/context@3.10.2
  - @claudexor/core@3.10.2
  - @claudexor/workspace@3.10.2
  - @claudexor/util@3.10.2

## 3.10.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.1
  - @claudexor/config@3.10.1
  - @claudexor/context@3.10.1
  - @claudexor/core@3.10.1
  - @claudexor/workspace@3.10.1
  - @claudexor/util@3.10.1

## 3.10.0

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.10.0
  - @claudexor/schema@3.10.0
  - @claudexor/context@3.10.0
  - @claudexor/workspace@3.10.0
  - @claudexor/config@3.10.0
  - @claudexor/util@3.10.0

## 3.9.8

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.8
  - @claudexor/config@3.9.8
  - @claudexor/context@3.9.8
  - @claudexor/core@3.9.8
  - @claudexor/workspace@3.9.8
  - @claudexor/util@3.9.8

## 3.9.7

### Patch Changes

- @claudexor/config@3.9.7
- @claudexor/context@3.9.7
- @claudexor/core@3.9.7
- @claudexor/schema@3.9.7
- @claudexor/util@3.9.7
- @claudexor/workspace@3.9.7

## 3.9.6

### Patch Changes

- Updated dependencies [dd02e0a]
  - @claudexor/workspace@3.9.6
  - @claudexor/config@3.9.6
  - @claudexor/context@3.9.6
  - @claudexor/core@3.9.6
  - @claudexor/schema@3.9.6
  - @claudexor/util@3.9.6

## 3.9.5

### Patch Changes

- @claudexor/config@3.9.5
- @claudexor/context@3.9.5
- @claudexor/core@3.9.5
- @claudexor/schema@3.9.5
- @claudexor/util@3.9.5
- @claudexor/workspace@3.9.5

## 3.9.4

### Patch Changes

- @claudexor/config@3.9.4
- @claudexor/context@3.9.4
- @claudexor/core@3.9.4
- @claudexor/schema@3.9.4
- @claudexor/util@3.9.4
- @claudexor/workspace@3.9.4

## 3.9.3

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.3
  - @claudexor/config@3.9.3
  - @claudexor/context@3.9.3
  - @claudexor/core@3.9.3
  - @claudexor/workspace@3.9.3
  - @claudexor/util@3.9.3

## 3.9.2

### Patch Changes

- @claudexor/config@3.9.2
- @claudexor/context@3.9.2
- @claudexor/core@3.9.2
- @claudexor/schema@3.9.2
- @claudexor/util@3.9.2
- @claudexor/workspace@3.9.2

## 3.9.1

### Patch Changes

- @claudexor/config@3.9.1
- @claudexor/context@3.9.1
- @claudexor/core@3.9.1
- @claudexor/schema@3.9.1
- @claudexor/util@3.9.1
- @claudexor/workspace@3.9.1

## 3.9.0

### Patch Changes

- Updated dependencies [d9cccac]
- Updated dependencies [69500f8]
- Updated dependencies [e39c57b]
- Updated dependencies [fd623ff]
- Updated dependencies [278e436]
  - @claudexor/schema@3.9.0
  - @claudexor/config@3.9.0
  - @claudexor/context@3.9.0
  - @claudexor/core@3.9.0
  - @claudexor/workspace@3.9.0
  - @claudexor/util@3.9.0

## 3.8.4

### Patch Changes

- @claudexor/config@3.8.4
- @claudexor/context@3.8.4
- @claudexor/core@3.8.4
- @claudexor/schema@3.8.4
- @claudexor/util@3.8.4
- @claudexor/workspace@3.8.4

## 3.8.3

### Patch Changes

- @claudexor/config@3.8.3
- @claudexor/context@3.8.3
- @claudexor/core@3.8.3
- @claudexor/schema@3.8.3
- @claudexor/util@3.8.3
- @claudexor/workspace@3.8.3

## 3.8.2

### Patch Changes

- @claudexor/config@3.8.2
- @claudexor/context@3.8.2
- @claudexor/core@3.8.2
- @claudexor/schema@3.8.2
- @claudexor/util@3.8.2
- @claudexor/workspace@3.8.2

## 3.8.1

### Patch Changes

- Updated dependencies [ce6dba1]
- Updated dependencies [2794ec7]
  - @claudexor/core@3.8.1
  - @claudexor/schema@3.8.1
  - @claudexor/util@3.8.1
  - @claudexor/context@3.8.1
  - @claudexor/config@3.8.1

## 3.8.0

### Patch Changes

- Updated dependencies [6054b7d]
  - @claudexor/schema@3.8.0
  - @claudexor/core@3.8.0
  - @claudexor/config@3.8.0
  - @claudexor/context@3.8.0
  - @claudexor/util@3.8.0

## 3.7.0

### Patch Changes

- @claudexor/config@3.7.0
- @claudexor/context@3.7.0
- @claudexor/core@3.7.0
- @claudexor/schema@3.7.0
- @claudexor/util@3.7.0

## 3.6.0

### Patch Changes

- Updated dependencies [895967f]
  - @claudexor/schema@3.6.0
  - @claudexor/config@3.6.0
  - @claudexor/context@3.6.0
  - @claudexor/core@3.6.0
  - @claudexor/util@3.6.0

## 3.5.0

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/util@3.5.0
  - @claudexor/config@3.5.0
  - @claudexor/context@3.5.0
  - @claudexor/core@3.5.0
  - @claudexor/schema@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/config@3.4.2
- @claudexor/context@3.4.2
- @claudexor/core@3.4.2
- @claudexor/schema@3.4.2
- @claudexor/util@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/config@3.4.1
- @claudexor/context@3.4.1
- @claudexor/core@3.4.1
- @claudexor/schema@3.4.1
- @claudexor/util@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/config@3.4.0
- @claudexor/context@3.4.0
- @claudexor/core@3.4.0
- @claudexor/schema@3.4.0
- @claudexor/util@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/config@3.3.16
- @claudexor/context@3.3.16
- @claudexor/core@3.3.16
- @claudexor/schema@3.3.16
- @claudexor/util@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/config@3.3.15
- @claudexor/context@3.3.15
- @claudexor/core@3.3.15
- @claudexor/schema@3.3.15
- @claudexor/util@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/config@3.3.14
- @claudexor/context@3.3.14
- @claudexor/core@3.3.14
- @claudexor/schema@3.3.14
- @claudexor/util@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/config@3.3.13
- @claudexor/context@3.3.13
- @claudexor/core@3.3.13
- @claudexor/schema@3.3.13
- @claudexor/util@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/config@3.3.12
- @claudexor/context@3.3.12
- @claudexor/core@3.3.12
- @claudexor/schema@3.3.12
- @claudexor/util@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/config@3.3.0
- @claudexor/context@3.3.0
- @claudexor/core@3.3.0
- @claudexor/schema@3.3.0
- @claudexor/util@3.3.0

## 3.2.1

### Patch Changes

- @claudexor/config@3.2.1
- @claudexor/context@3.2.1
- @claudexor/core@3.2.1
- @claudexor/schema@3.2.1
- @claudexor/util@3.2.1

## 3.2.0

### Patch Changes

- Retire the standalone Plan-review subject so the release reviewer remains a code-review owner while Plan uses its own read-only contract.
- Build each native reviewer workspace from the Git-visible candidate inventory
  plus exact diff postimages, keeping unrelated ignored local state outside the
  separately copied evidence packet.
- Persist candidate review-runtime identity, native auth routes, ignored-setting
  evidence, and strict sealed completion envelopes so schema-v5 release sealing
  can derive both required full-context verdicts from disk instead of trusting
  caller labels.
- For frozen release review, persist the exact submitted prompt, session,
  live external-context/web policy, runtime-entry digest, normalized events,
  and deterministic transcript projection; disable internal transient retries
  so an operator retry starts a fresh evidence wave.
- Require a sealed reviewer completion to be exactly one JSON value, with no
  prose, code fence, or duplicate envelope around it.
- @claudexor/config@3.2.0
- @claudexor/context@3.2.0
- @claudexor/core@3.2.0
- @claudexor/schema@3.2.0
- @claudexor/util@3.2.0

## 3.1.2

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.1.2
  - @claudexor/schema@3.1.2
  - @claudexor/context@3.1.2
  - @claudexor/config@3.1.2
  - @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- The review loop's finding contract is pinned explicitly in both loop prompts,
  and a reviewer effort the selected reviewer does not advertise is refused (the
  auto panel discloses and drops an unadvertised reviewer effort level).
- Updated dependencies
- Updated dependencies
  - @claudexor/core@3.1.1
  - @claudexor/schema@3.1.1
  - @claudexor/context@3.1.1
  - @claudexor/config@3.1.1
  - @claudexor/util@3.1.1

## 3.1.0

### Patch Changes

- Updated dependencies [c3b7ece]
- Updated dependencies [6e36993]
  - @claudexor/schema@3.1.0
  - @claudexor/core@3.1.0
  - @claudexor/config@3.1.0
  - @claudexor/context@3.1.0
  - @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/config@3.0.3
- @claudexor/context@3.0.3
- @claudexor/core@3.0.3
- @claudexor/schema@3.0.3
- @claudexor/util@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/config@3.0.0
- @claudexor/context@3.0.0
- @claudexor/core@3.0.0
- @claudexor/schema@3.0.0
- @claudexor/util@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/config@2.1.3
- @claudexor/context@2.1.3
- @claudexor/core@2.1.3
- @claudexor/schema@2.1.3
- @claudexor/util@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/config@2.1.2
- @claudexor/context@2.1.2
- @claudexor/core@2.1.2
- @claudexor/schema@2.1.2
- @claudexor/util@2.1.2

## 2.1.1

### Patch Changes

- @claudexor/config@2.1.1
- @claudexor/context@2.1.1
- @claudexor/core@2.1.1
- @claudexor/schema@2.1.1
- @claudexor/util@2.1.1

## 2.1.0

### Patch Changes

- Updated dependencies
- Updated dependencies [0fc050b]
  - @claudexor/schema@2.1.0
  - @claudexor/core@2.1.0
  - @claudexor/config@2.1.0
  - @claudexor/context@2.1.0
  - @claudexor/util@2.1.0

## 2.0.2

### Patch Changes

- @claudexor/config@2.0.2
- @claudexor/context@2.0.2
- @claudexor/core@2.0.2
- @claudexor/schema@2.0.2
- @claudexor/util@2.0.2

## 2.0.1

### Patch Changes

- @claudexor/config@2.0.1
- @claudexor/context@2.0.1
- @claudexor/core@2.0.1
- @claudexor/schema@2.0.1
- @claudexor/util@2.0.1

## 2.0.0

### Patch Changes

- @claudexor/config@2.0.0
- @claudexor/context@2.0.0
- @claudexor/core@2.0.0
- @claudexor/schema@2.0.0
- @claudexor/util@2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

### Patch Changes

- Stabilize the checkpoint release with explicit reviewer-panel hardening, mandatory
  review evidence preflight, scoped Cursor reviewer readiness, frozen SpecPack gate
  merging, protected-path approvals, and thin control/macOS projection parity.
- Fail reviewer evidence setup before reviewer children start when a candidate
  diff contains secret-like content that would otherwise be persisted as raw
  `DIFF.patch`.
- Updated dependencies
  - @claudexor/core@0.14.1
  - @claudexor/context@0.14.1
  - @claudexor/schema@0.14.1
  - @claudexor/util@0.14.1

## 0.14.0

### Patch Changes

- @claudexor/core@0.14.0
- @claudexor/schema@0.14.0
- @claudexor/util@0.14.0

## 0.13.3

### Patch Changes

- @claudexor/core@0.13.3
- @claudexor/schema@0.13.3
- @claudexor/util@0.13.3

## 0.12.1

### Patch Changes

- @claudexor/core@0.12.1
- @claudexor/schema@0.12.1
- @claudexor/util@0.12.1
