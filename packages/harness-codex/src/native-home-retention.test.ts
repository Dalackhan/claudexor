import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CONTINUITY_PROFILE_LOCATOR_ENV } from "@claudexor/core";
import { createCodexAdapter } from "./index.js";
const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const old = new Date("2020-01-01");
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
function fixture() {
  const path = join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", `retention-${roots.length}`);
  mkdirSync(path, { recursive: true });
  roots.push(path);
  const home = realpathSync(path);
  const adapter = createCodexAdapter();
  const lifetime = adapter.nativeHomeLifetime!;
  if (lifetime.status !== "managed") throw new Error("missing native owner");
  const seed = (n: number, ext = ".jsonl", date = old) => {
    const day = join(home, "sessions", "2020", "01", "01");
    mkdirSync(day, { recursive: true });
    const file = join(day, `rollout-2020-01-01T00-00-00-${id(n)}${ext}`);
    writeFileSync(file, `session ${n}`);
    utimesSync(file, date, date);
    return file;
  };
  const prune = (protectedIds: string[] = [], dryRun = false, maxDeletions = 500) =>
    lifetime.prune({
      home,
      protectedSessionIds: new Set(protectedIds),
      olderThan: Date.now() - 30 * 86400000,
      dryRun,
      maxDeletions,
    });
  return { home, adapter, lifetime, seed, prune };
}
it("deletes old unreferenced parts and preserves resume, recent groups, credentials, config and SQLite", async () => {
  const f = fixture();
  const discard = f.seed(1);
  const compressed = f.seed(1, ".jsonl.zst");
  const held = f.seed(2);
  const recentSibling = f.seed(3);
  f.seed(3, ".jsonl.zst", new Date());
  const protectedPaths = [
    "auth.json",
    "config.toml",
    "logs_1.sqlite",
    "state_5.sqlite",
    "archived_sessions/old.jsonl",
    "sessions/2020/01/01/unknown.jsonl",
  ];
  for (const name of protectedPaths) {
    const p = join(f.home, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, `unchanged ${name}`);
  }
  const preview = f.prune([id(2)], true);
  expect(preview.deleted_files.sort()).toEqual([discard, compressed].sort());
  expect(existsSync(discard)).toBe(true);
  const result = f.prune([id(2)]);
  expect(result.deleted_files.sort()).toEqual(preview.deleted_files);
  expect(result.freed_bytes).toBe(18);
  expect(existsSync(discard)).toBe(false);
  expect(existsSync(held)).toBe(true);
  expect(existsSync(recentSibling)).toBe(true);
  expect(result.kept_referenced).toBe(1);
  expect(result.kept_recent).toBe(2);
  for (const name of protectedPaths)
    expect(readFileSync(join(f.home, name), "utf8")).toBe(`unchanged ${name}`);
  expect(
    await f.adapter.continuity!.locate(
      { nativeSessionId: id(2), cwd: "/scratch" },
      { [CONTINUITY_PROFILE_LOCATOR_ENV]: f.home },
    ),
  ).toMatchObject({ found: true, file: held });
});
it("fails closed on unrecognized references, then prunes when proof is valid", () => {
  const f = fixture();
  const file = f.seed(1);
  expect(() => f.prune(["unknown-reference-format"])).toThrow("unrecognized");
  expect(existsSync(file)).toBe(true);
  expect(f.prune().deleted_files).toEqual([file]);
});
it("never follows linked stores or unknown layouts and rejects an outside home", () => {
  const f = fixture();
  const outside = fixture();
  const target = outside.seed(4);
  symlinkSync(join(outside.home, "sessions"), join(f.home, "sessions"), "dir");
  expect(() => f.prune()).toThrow("plain directory");
  expect(existsSync(target)).toBe(true);
  expect(() =>
    f.lifetime.home({ [CONTINUITY_PROFILE_LOCATOR_ENV]: "/outside-owned-root" }),
  ).toThrow();
});
it("continues a bounded cold-store pass", () => {
  const f = fixture();
  for (let n = 0; n < 3; n++) f.seed(n);
  expect(f.prune([], false, 2)).toMatchObject({
    truncated: true,
    deleted_files: expect.any(Array),
  });
  expect(f.prune([], false, 2)).toMatchObject({
    truncated: false,
    deleted_files: expect.arrayContaining([expect.stringContaining(id(2))]),
  });
});
