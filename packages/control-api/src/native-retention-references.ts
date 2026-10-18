import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { RunResumable, SessionCapsule } from "@claudexor/schema";
import { userConfigDir } from "@claudexor/util";
import { RETIRING } from "./retention-removal.js";

async function optionalStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function directories(path: string): Promise<string[]> {
  const stat = await optionalStat(path);
  if (!stat) return [];
  if (!stat.isDirectory()) throw new Error(`native references require a plain directory: ${path}`);
  return (await readdir(path, { withFileTypes: true })).flatMap((entry) => {
    if (entry.isSymbolicLink())
      throw new Error(`native references cannot follow ${join(path, entry.name)}`);
    return entry.isDirectory() ? [entry.name] : [];
  });
}
async function readOptional(path: string): Promise<string | null> {
  const stat = await optionalStat(path);
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`native reference is not a plain file: ${path}`);
  return readFile(path, "utf8");
}

/** Every retained run can be a continuation source. A corrupt or unreadable
 * capsule/resumable record aborts the entire native pass BEFORE any unlink. */
export async function retainedNativeSessions(
  sessions: Map<string, Set<string>>,
  ignoredRunIds: ReadonlySet<string> = new Set(),
  signal?: AbortSignal,
): Promise<Map<string, Set<string>>> {
  const result = new Map([...sessions].map(([harness, ids]) => [harness, new Set(ids)]));
  const add = (harness: string, id: string) => {
    const ids = result.get(harness) ?? new Set<string>();
    ids.add(id);
    result.set(harness, ids);
  };
  const projects = join(userConfigDir(), "projects");
  for (const hash of await directories(projects)) {
    signal?.throwIfAborted();
    if (!/^[0-9a-f]{64}$/.test(hash)) continue;
    const runs = join(projects, hash, "runs");
    for (const id of await directories(runs)) {
      signal?.throwIfAborted();
      if (id === RETIRING || ignoredRunIds.has(id)) continue;
      const run = join(runs, id);
      const final = join(run, "final");
      const finalStat = await optionalStat(final);
      if (finalStat && !finalStat.isDirectory())
        throw new Error(`native references cannot read ${final}`);
      const resumableText = await readOptional(join(final, "resumable.yaml"));
      if (resumableText !== null) {
        const resumable = RunResumable.parse(yamlParse(resumableText));
        if (resumable.session) add(resumable.session.harness, resumable.session.nativeSessionId);
      }
      const attempts = join(run, "attempts");
      for (const attempt of await directories(attempts)) {
        signal?.throwIfAborted();
        const text = await readOptional(join(attempts, attempt, "session-capsule.json"));
        if (text === null) continue;
        const capsule = SessionCapsule.parse(JSON.parse(text));
        add(capsule.harness, capsule.nativeSessionId);
      }
    }
  }
  return result;
}
