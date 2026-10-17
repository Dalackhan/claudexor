import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { RunResumable, SessionCapsule } from "@claudexor/schema";
import { userConfigDir } from "@claudexor/util";

function optionalStat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function directories(path: string): string[] {
  const stat = optionalStat(path);
  if (!stat) return [];
  if (!stat.isDirectory()) throw new Error(`native references require a plain directory: ${path}`);
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink())
      throw new Error(`native references cannot follow ${join(path, entry.name)}`);
    return entry.isDirectory() ? [entry.name] : [];
  });
}
function readOptional(path: string): string | null {
  const stat = optionalStat(path);
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`native reference is not a plain file: ${path}`);
  return readFileSync(path, "utf8");
}

/** Every retained run can be a continuation source. A corrupt or unreadable
 * capsule/resumable record aborts the entire native pass BEFORE any unlink. */
export function retainedNativeSessions(
  sessions: Map<string, Set<string>>,
  ignoredRunIds: ReadonlySet<string> = new Set(),
): Map<string, Set<string>> {
  const result = new Map([...sessions].map(([harness, ids]) => [harness, new Set(ids)]));
  const add = (harness: string, id: string) => {
    const ids = result.get(harness) ?? new Set<string>();
    ids.add(id);
    result.set(harness, ids);
  };
  const projects = join(userConfigDir(), "projects");
  for (const hash of directories(projects)) {
    if (!/^[0-9a-f]{64}$/.test(hash)) continue;
    const runs = join(projects, hash, "runs");
    for (const id of directories(runs)) {
      if (ignoredRunIds.has(id)) continue;
      const run = join(runs, id);
      const final = join(run, "final");
      const finalStat = optionalStat(final);
      if (finalStat && !finalStat.isDirectory())
        throw new Error(`native references cannot read ${final}`);
      const resumableText = readOptional(join(final, "resumable.yaml"));
      if (resumableText !== null) {
        const resumable = RunResumable.parse(yamlParse(resumableText));
        if (resumable.session) add(resumable.session.harness, resumable.session.nativeSessionId);
      }
      const attempts = join(run, "attempts");
      for (const attempt of directories(attempts)) {
        const text = readOptional(join(attempts, attempt, "session-capsule.json"));
        if (text === null) continue;
        const capsule = SessionCapsule.parse(JSON.parse(text));
        add(capsule.harness, capsule.nativeSessionId);
      }
    }
  }
  return result;
}
