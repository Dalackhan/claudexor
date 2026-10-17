import type { GcNativeHomeReport } from "@claudexor/schema";
import type { EnvMap } from "./adapter.js";

export interface NativeHomeRetentionInput {
  home: string;
  protectedSessionIds: ReadonlySet<string>;
  olderThan: number;
  dryRun: boolean;
  maxDeletions: number;
}
export type NativeHomeRetentionResult = Pick<
  GcNativeHomeReport,
  | "deleted_files"
  | "errors"
  | "freed_bytes"
  | "kept_referenced"
  | "kept_recent"
  | "kept_unknown"
  | "truncated"
>;
/** Synchronous inventory + retirement prevents engine admission interleaving
 * with a proven idle reference snapshot. Unknown formats are never guessed. */
export type NativeHomeLifetime =
  | { status: "not_pruned"; reason: string }
  | {
      status: "managed";
      preserves: string;
      home(env: EnvMap): string;
      prune(input: NativeHomeRetentionInput): NativeHomeRetentionResult;
    };
