import { CONTINUITY_PROFILE_LOCATOR_ENV, type AdapterRegistry } from "@claudexor/core";
import { loadConfig } from "@claudexor/config";
import type { ProjectThreadPort } from "@claudexor/daemon";
import {
  isTerminalLifecycle,
  type CredentialProfile,
  type GcNativeHomeReport,
} from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import { buildRegistry } from "./registry.js";
import { retainedNativeSessions } from "@claudexor/control-api";

export interface NativeRetentionRequest {
  dryRun: boolean;
  olderThan: number;
  ignoredRunIds: ReadonlySet<string>;
  ignoredThreadIds: ReadonlySet<string>;
}
export interface NativeRetentionResult {
  reports: GcNativeHomeReport[];
  errors: string[];
  freedBytes: number;
  truncated: boolean;
}
export function createNativeHomeRetention(deps: {
  threads: ProjectThreadPort;
  /** Rechecked synchronously before every unlink; inventory never fences admission. */
  isBusy: () => boolean;
  registry?: () => AdapterRegistry;
  profiles?: () => CredentialProfile[];
  maxDeletions?: number;
}): (request: NativeRetentionRequest) => Promise<NativeRetentionResult> {
  return async (request) => {
    const result: NativeRetentionResult = {
      reports: [],
      errors: [],
      freedBytes: 0,
      truncated: false,
    };
    let closeReferences = () => {};
    try {
      let references = new Map<string, Set<string>>();
      let blocked: string | null = null;
      let canPrune = () => false;
      try {
        const snapshot = await deps.threads.retentionReferences(request.ignoredThreadIds);
        closeReferences = () => snapshot.close?.();
        if (
          deps.isBusy() ||
          snapshot.hasActiveCommands?.() ||
          snapshot.records.some((record) => !isTerminalLifecycle(record.state))
        )
          throw new Error(
            "native homes kept while a run or setup operation is active or unresolved",
          );
        if (snapshot.protectedProjectRoots.size)
          throw new Error("native homes kept until unavailable project generations recover");
        canPrune = () => {
          try {
            return (snapshot.nativeCurrent ?? snapshot.isCurrent)() && !deps.isBusy();
          } catch {
            return false;
          } // Keep partial receipts when a new owner is unreadable.
        };
        await snapshot.refresh?.();
        if (!canPrune()) throw new Error("native retention references changed; homes kept");
        references = await retainedNativeSessions(snapshot.nativeSessions, request.ignoredRunIds);
        await snapshot.refresh?.();
        if (!canPrune())
          throw new Error(
            "native retention references or idle state changed during inventory; homes kept",
          );
      } catch (error) {
        blocked = error instanceof Error ? error.message : String(error);
        result.errors.push(`native retention: ${blocked}`);
      }
      const registry = (deps.registry ?? (() => buildRegistry({ includeFakes: false })))();
      const profiles = (
        deps.profiles ?? (() => loadConfig(noProjectRepoRoot()).global.credential_profiles)
      )();
      let remaining = deps.maxDeletions ?? 500;
      for (const [harness, adapter] of registry) {
        const lifetime = adapter.nativeHomeLifetime;
        if (!lifetime) continue; // API-only/fake adapters own no native home.
        const seen = new Set<string>();
        const homes = [
          null,
          ...profiles.filter(
            (profile) =>
              profile.harness_id === harness && profile.credential_kind === "config_dir_login",
          ),
        ];
        for (const profile of homes) {
          const report: GcNativeHomeReport = {
            harness_id: harness,
            profile_id: profile?.profile_id ?? null,
            home: null,
            status: "not_pruned",
            reason: "",
            deleted_files: [],
            errors: [],
            freed_bytes: 0,
            kept_referenced: 0,
            kept_recent: 0,
            kept_unknown: 0,
            truncated: false,
          };
          result.reports.push(report);
          if (lifetime.status === "not_pruned") {
            report.reason = lifetime.reason;
            continue;
          }
          try {
            report.home = lifetime.home(
              profile?.isolation_locator
                ? { [CONTINUITY_PROFILE_LOCATOR_ENV]: profile.isolation_locator }
                : {},
            );
            if (seen.has(report.home)) {
              report.reason = "same native home already considered this pass";
              continue;
            }
            seen.add(report.home);
            if (!blocked && !canPrune()) {
              blocked = "native retention references or idle state changed; remaining homes kept";
              result.errors.push(`native retention: ${blocked}`);
            }
            if (blocked) {
              report.reason = blocked;
              continue;
            }
            const pruned = await lifetime.prune({
              home: report.home,
              protectedSessionIds: references.get(harness) ?? new Set(),
              olderThan: request.olderThan,
              dryRun: request.dryRun,
              maxDeletions: remaining,
              canPrune,
            });
            Object.assign(report, pruned, { status: "checked", reason: lifetime.preserves });
            remaining -= pruned.deleted_files.length;
            result.freedBytes += pruned.freed_bytes;
            result.errors.push(...pruned.errors);
            result.truncated ||= pruned.truncated;
          } catch (error) {
            report.reason = error instanceof Error ? error.message : String(error);
            result.errors.push(
              `native home ${harness}/${profile?.profile_id ?? "default"}: ${report.reason}`,
            );
          }
        }
      }
      return result;
    } finally {
      closeReferences();
    }
  };
}
