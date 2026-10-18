import { lstatSync, unlinkSync, type Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import { join } from "node:path";
import type { NativeHomeLifetime, NativeHomeRetentionInput } from "@claudexor/core";
import { canonicalIsolationLocator } from "@claudexor/core";
import { codexContinuity, codexStoreHome } from "./continuity.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROLLOUT = new RegExp(`^rollout-.+-(${UUID})\\.jsonl(?:\\.zst)?$`, "i");
const SESSION_ID = new RegExp(`^${UUID}$`, "i");

/** The same filename/part contract as codexContinuity. SQLite logs and indexes
 * have no proven independent deletion contract and are deliberately untouched. */
async function prune(input: NativeHomeRetentionInput) {
  const result = {
    deleted_files: [] as string[],
    errors: [] as string[],
    freed_bytes: 0,
    kept_referenced: 0,
    kept_recent: 0,
    kept_unknown: 0,
    truncated: false,
  };
  const cancelled = () => {
    if (!input.signal?.aborted) return false;
    result.truncated = true;
    if (!result.errors.length)
      result.errors.push(`native retention cancelled for ${input.home}; resume next pass`);
    return true;
  };
  if (cancelled()) return result;
  const protectedIds = new Set(
    [...input.protectedSessionIds].map((id) => {
      if (!SESSION_ID.test(id)) throw new Error("unrecognized Codex session reference; home kept");
      return id.toLowerCase();
    }),
  );
  const home = canonicalIsolationLocator(input.home, "Codex retention home");
  const sessions = join(home, "sessions");
  const sessionsStat = await lstat(sessions).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!sessionsStat) return result;
  if (!sessionsStat.isDirectory())
    throw new Error("Codex sessions is not a plain directory; home kept");
  const groups = new Map<string, Array<{ path: string; stat: Stats }>>();
  const scan = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (cancelled()) return;
      const path = join(dir, entry.name);
      if (
        depth > 0 &&
        entry.isDirectory() &&
        (depth === 3 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)
      )
        await scan(path, depth - 1);
      else if (depth === 0 && entry.isFile()) {
        const match = ROLLOUT.exec(entry.name);
        if (!match) {
          result.kept_unknown += 1;
          continue;
        }
        const id = match[1]!.toLowerCase();
        const parts = groups.get(id) ?? [];
        parts.push({ path, stat: await lstat(path) });
        groups.set(id, parts);
      } else result.kept_unknown += 1;
    }
  };
  // Complete inventory before the first unlink; a failed read deletes nothing.
  await scan(sessions, 3);
  for (const [id, parts] of groups) {
    if (cancelled()) return result;
    if (protectedIds.has(id)) {
      result.kept_referenced += parts.length;
      continue;
    }
    if (parts.some((part) => part.stat.mtimeMs >= input.olderThan)) {
      result.kept_recent += parts.length;
      continue;
    }
    await yieldToAdmission();
    if (cancelled()) return result;
    let current: Stats[];
    try {
      current = parts.map((part) => lstatSync(part.path));
    } catch (error) {
      result.errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (
      current.some(
        (stat, i) =>
          !stat.isFile() ||
          stat.dev !== parts[i]!.stat.dev ||
          stat.ino !== parts[i]!.stat.ino ||
          stat.mtimeMs !== parts[i]!.stat.mtimeMs ||
          stat.size !== parts[i]!.stat.size,
      )
    ) {
      result.kept_unknown += parts.length;
      continue;
    }
    for (const [i, part] of parts.entries()) {
      if (cancelled()) return result;
      if (result.deleted_files.length >= input.maxDeletions) {
        result.truncated = true;
        return result;
      }
      let currentProof: boolean;
      try {
        currentProof = input.canPrune();
      } catch (error) {
        result.errors.push(
          `native retention proof unreadable; remaining files kept: ${String(error)}`,
        );
        return result;
      }
      if (!currentProof) {
        result.errors.push(
          "native retention references or idle state changed; remaining files kept",
        );
        return result;
      }
      try {
        // No await from this fresh proof through unlink; admission remains
        // free during the inventory, never between proof and this action.
        if (!input.dryRun) unlinkSync(part.path);
        result.deleted_files.push(part.path);
        if (current[i]!.nlink === 1) result.freed_bytes += current[i]!.size;
      } catch (error) {
        result.errors.push(
          `${part.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return result;
}

const codexNativeHomeLifetime: NativeHomeLifetime = {
  status: "managed",
  preserves:
    "Credentials, configuration, SQLite logs/indexes, archived sessions and unknown layouts; referenced or recently updated rollout parts.",
  home: (env) => canonicalIsolationLocator(codexStoreHome(env), "Codex retention home"),
  prune,
};

export const codexPersistence = {
  continuity: codexContinuity,
  nativeHomeLifetime: codexNativeHomeLifetime,
};
