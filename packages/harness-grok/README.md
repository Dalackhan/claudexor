# Grok Build harness

Runs the official xAI Grok Build CLI using a grok.com subscription, without an
API key. Discovery checks `CLAUDEXOR_GROK_BIN`, PATH, then `~/.grok/bin/grok`
(`grok.exe` on Windows). An explicit override is authoritative even if missing.

```sh
claudexor doctor --harness grok
claudexor profiles add grok work
claudexor profiles login grok work
claudexor ask "Reply with just OK" --harness grok --profile work
claudexor agent "Fix the typo" --harness grok --profile work --access workspace_write
claudexor best-of "Improve the error message" --harness codex,grok --n 2
```

Named profiles use isolated HOME/USERPROFILE and `GROK_HOME=<profile>/.grok`
for login, models and execution. An invalid profile never uses host credentials.
Grok has no default credential store or `auth login grok` bootstrap command.
Runs require a named profile selected explicitly or by the account pool; host
`GROK_HOME` and `~/.grok` credentials are never used. Harness-level doctor
reports the absent default store; named profile probes own account readiness.
`grok models` verifies the subscription without generation; file presence is
diagnostic only. The official CLI owns OIDC renewal. Provider keys and redirects
are scrubbed. `GROK_DISABLE_AUTOUPDATER=1` disables vendor auto-update for login
and execution; headless runs also pass `--no-auto-update`. Inherited
`GROK_CONFIG` and `GROK_CONFIG_PATH` overrides are removed.
Login uses `grok login --device-auth`.

The selected account's native model ids pass through unchanged; inventory
absence is advisory. Recorded effort levels are `low`, `medium`, `high`,
`xhigh`, resolved by the shared effort resolver. Native `--max-turns`,
`--json-schema`, additive `--rules`, and `--resume` are forwarded.
Task text uses a private `--prompt-file` to avoid process argument length limits.

| Access | Policy |
| --- | --- |
| `readonly` | Read/list/grep only; writes, shell, MCP meta-tools and subagents disabled. |
| `workspace_write` | Read tools plus `search_replace`/`write`; `dontAsk` with explicit Edit/Write rules for the canonical working directory; shell, MCP meta-tools and subagents disabled. |
| `full` | `--always-approve` with the vendor's full toolset. |
| `inherit_native` | Vendor permission defaults. |

These are native tool policies, not an OS sandbox. Scoped modes cannot run
shell builds or tests. Vendor hooks and project permission configuration remain
vendor-owned; use trusted project configuration. Auxiliary writable roots,
engine MCP injection, cross-account session moves and store pruning are unsupported.

`streaming-messages-json` supplies init/model/session evidence, messages,
paired tool calls/results, successful file edits, the typed final and one
aggregate usage record. Thinking signatures are discarded. JSON response
envelopes are also recognized. Vendor errors and stderr quota/rate failures
become typed `rate_limit` signals, persisted as `grok_rate_limit` cooldowns for
normal routing and account rotation. Remaining subscription allowance stays
unknown until vendor evidence arrives. OAuth accounting is not presented as
a metered API charge. Native schema output is forwarded; engine WorkReport
transport remains unsupported pending separate proof.

Automatic routing can fall back from unavailable Grok to another ready harness,
with a degradation receipt. An explicit `--harness grok,codex` pool retains the
engine's strict membership contract: an unavailable forced member refuses the
request. Use `--primary-harness grok` with the automatic pool for availability
fallback; a single `--harness grok` is also strict.

Offline tests: `pnpm exec vitest run packages/harness-grok/src`.
Fixture provenance: `fixtures/manifest.yaml`.
Official documentation: <https://docs.x.ai/build/overview>.
