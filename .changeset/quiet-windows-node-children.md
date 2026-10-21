---
"@claudexor/core": patch
"@claudexor/cli": patch
"@claudexor/harness-codex": patch
---

Keep native children of Windows npm harness wrappers hidden during piped background
captures. The shared capture helpers preload a packaged CommonJS file into the
vendor's selected Node (16 or later), so its own `spawn`/`spawnSync` calls default to
a hidden window while explicit choices, Node's argument errors, the vendor entrypoint,
arguments and scoped environment stay unchanged. Codex quota and model discovery,
the install version proof and the `login --help` probe start their direct child
without a console window. Interactive sign-in, attach and vendor update keep their
own terminal policy.
