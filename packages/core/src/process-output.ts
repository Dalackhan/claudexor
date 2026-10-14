/** Compact, attributable one-line stream details for probes and diagnostics. */
/**
 * Label which stream said what in a compact one-line detail (truncated probe
 * errors must stay attributable to stderr vs stdout). Null when both are empty.
 *
 * `transform` (e.g. a secret redactor) runs on each FULL stream BEFORE
 * truncation — truncating first could split a token and leave a partial
 * secret the redactor no longer recognizes. Each present stream then gets an
 * equal code-point budget (never splitting a surrogate pair), so one noisy
 * stream cannot evict the other from the detail.
 */
export function labelStreams(
  stderr: string,
  stdout: string,
  opts: { maxLen?: number; transform?: (s: string) => string } = {},
): string | null {
  const maxLen = opts.maxLen ?? 300;
  const transform = opts.transform ?? ((s: string): string => s);
  const streams: Array<[string, string]> = [
    ["stderr", stderr],
    ["stdout", stdout],
  ].filter((entry): entry is [string, string] => entry[1].trim() !== "");
  if (streams.length === 0) return null;
  const budget = Math.max(1, Math.floor(maxLen / streams.length));
  const parts = streams.map(([label, raw]) => {
    const clean = [...transform(raw.trim())].slice(0, budget).join("");
    return `${label}: ${clean}`;
  });
  return parts.join(" | ");
}
