# @claudexor/harness-grok

## 4.8.0

### Minor Changes

- 6c31c44: Add the Grok Build subscription CLI harness: named accounts with isolated
  profile homes, device login, account model lists, shared effort placement,
  stream parsing and reactive quota cooldowns for pools and rotation. Readiness
  comes from `grok models` in the profile env, and an inconclusive probe stays
  unknown instead of marking the account dead; failure text from a run is never
  read as an authentication verdict either. Session login is confirmed from
  Grok's init frame; a contradicting source fails the attempt as the new typed
  `credential_source_unconfirmed` request refusal, without a retry or account
  rotation, even when the same frame also contradicts the scoped tool policy.
  Claudexor never selects an API key, but a key in Grok's own configuration can
  send a paid request before that check, as the adapter README discloses.
  Subscription cash is reported unknown, not zero. Grok joins the macOS Add Account picker and
  the shared credential-store path rules, so a directory run never copies or
  publishes a selected `.grok/` directory; leave it out of `--scope-path`. An app
  built before this change cannot decode an active Grok login job, and its
  engine-update check reports busy until that login finishes or is cancelled.
  Applied attempt facts now name the HOME a Grok, Antigravity or Cursor profile
  child actually received.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies [6c31c44]
  - @claudexor/schema@4.8.0
  - @claudexor/core@4.8.0
  - @claudexor/util@4.8.0
