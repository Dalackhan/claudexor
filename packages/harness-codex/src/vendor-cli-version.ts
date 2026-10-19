import type { PinnedVendorCliVersion } from "@claudexor/util";

/**
 * The ONE Codex vendor-CLI version this Claudexor release verified. Readers
 * alias it for the effort-snapshot and known-model freshness stamps, and for
 * the EXPLICIT `--release-tested` installer target, selected without a latest
 * lookup (a runnable managed copy at or above it is kept; installing it still
 * needs the npm registry). An ordinary
 * managed Codex install resolves npm latest separately; a newer selected
 * version does not inherit the recorded native compatibility evidence.
 * The HTTP model catalog's `client_version` is NOT a reader: it declares the
 * transport's own verified level (`CODEX_HTTP_CLIENT_VERSION`,
 * http-client-version.ts), raised to a newer installed CLI. Bump this baseline
 * ONLY while re-recording the effort snapshot (and re-checking the manifest's
 * known-model hints) against the same CLI build. Re-probe the native turn-text
 * input bound before updating capability-profile.ts's input-limit provenance;
 * a new unverified CLI version intentionally publishes no input bound.
 */
export const CODEX_VENDOR_CLI_VERSION: PinnedVendorCliVersion = "0.162.1";
