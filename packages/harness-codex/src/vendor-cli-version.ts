import type { PinnedVendorCliVersion } from "@claudexor/util";

/**
 * The ONE Codex vendor-CLI version this Claudexor release is verified
 * against — the pinned-install SSOT (issue #89). Readers alias it and
 * therefore can never drift apart:
 * - `CODEX_EFFORT_SNAPSHOT_VERIFIED_AGAINST` (effort-snapshot trust gate),
 * - the manifest's `known_models_verified_against` stamp,
 * - the remote harness installer's exact `@openai/codex@<v>` pin.
 * The HTTP model catalog's `client_version` is NOT a reader: it declares the
 * transport's own verified level (`CODEX_HTTP_CLIENT_VERSION`,
 * http-client-version.ts), raised to a newer installed CLI. Bump this pin
 * ONLY while re-recording the effort snapshot (and re-checking the manifest's
 * known-model hints) against the same CLI build. Re-probe the native turn-text
 * input bound before updating capability-profile.ts's input-limit provenance;
 * a new unverified CLI version intentionally publishes no input bound.
 */
export const CODEX_VENDOR_CLI_VERSION: PinnedVendorCliVersion = "0.162.1";
