import { lstat, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { DiskRetentionReferences } from "@claudexor/daemon";
import type { RetentionProject } from "@claudexor/control-api";
import { projectRuntimeDir, userConfigDir } from "@claudexor/util";

/** Directory inventory owns reachability. Active registrations and extant
 * archives own recent history; thread roots only name references. */
export async function retentionProjects(
  references: DiskRetentionReferences,
  noProjectRoot: string,
  healthyRoots: ReadonlySet<string>,
  errors: string[] = [],
  signal?: AbortSignal,
): Promise<RetentionProject[]> {
  const projects: RetentionProject[] = [];
  const byHash = new Map<string, string>();
  for (const root of references.projectRoots) {
    await yieldToAdmission();
    signal?.throwIfAborted();
    byHash.set(basename(projectRuntimeDir(root)), root);
  }
  byHash.set(basename(projectRuntimeDir(noProjectRoot)), noProjectRoot);
  const ownedRoots = new Set([noProjectRoot, ...references.registeredProjectRoots]);
  for (const root of references.archivedProjectRoots ?? []) {
    await yieldToAdmission();
    signal?.throwIfAborted();
    try {
      await stat(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") ownedRoots.delete(root);
      else
        errors.push(
          `namespace ${root}: archived root availability unknown; keep-last preserved: ${String(error)}`,
        );
    }
  }
  const protectedHashes = new Set(
    [...references.protectedProjectRoots].map((root) => basename(projectRuntimeDir(root))),
  );
  const directory = join(userConfigDir(), "projects");
  const directoryStat = await optionalStat(directory);
  if (directoryStat) {
    if (!directoryStat.isDirectory())
      throw new Error(`retention projects directory ${directory} is not a plain directory`);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (
        !/^[0-9a-f]{64}$/.test(entry.name) ||
        !entry.isDirectory() ||
        protectedHashes.has(entry.name)
      )
        continue;
      signal?.throwIfAborted();
      const runtime = join(directory, entry.name);
      if (references.blocked) {
        errors.push(`namespace ${byHash.get(entry.name) ?? runtime} kept: ${references.blocked}`);
        continue;
      }
      const runsDir = join(runtime, "runs");
      const runsStat = await optionalStat(runsDir);
      if (runsStat && !runsStat.isDirectory()) continue;
      const root = byHash.get(entry.name);
      projects.push({
        // Without a retained root, disclose the engine namespace rather than guessing a user path.
        root: root ?? runtime,
        runsDir,
        reviewsDir: root && healthyRoots.has(root) ? join(root, ".claudexor", "reviews") : null,
        keepLastRuns: root !== undefined && ownedRoots.has(root),
      });
    }
  }
  const inventoriedRoots = new Set(projects.map((project) => project.root));
  // A healthy repository can contain review debris before its first run.
  for (const root of healthyRoots) {
    signal?.throwIfAborted();
    if (
      references.blocked ||
      references.protectedProjectRoots.has(root) ||
      inventoriedRoots.has(root)
    )
      continue;
    const runtime = projectRuntimeDir(root);
    const runtimeStat = await optionalStat(runtime);
    if (runtimeStat && !runtimeStat.isDirectory()) continue;
    const runsDir = new ArtifactStore(root).runsDir();
    const runsStat = await optionalStat(runsDir);
    if (runsStat && !runsStat.isDirectory()) continue;
    projects.push({
      root,
      runsDir,
      reviewsDir: join(root, ".claudexor", "reviews"),
      keepLastRuns: ownedRoots.has(root),
    });
  }
  const noProjectRuns = new ArtifactStore(noProjectRoot).runsDir();
  const noProjectRuntime = projectRuntimeDir(noProjectRoot);
  const noProjectRuntimeStat = await optionalStat(noProjectRuntime);
  if (noProjectRuntimeStat && !noProjectRuntimeStat.isDirectory()) return projects;
  const noProjectRunsStat = await optionalStat(noProjectRuns);
  if (
    !references.blocked &&
    (!noProjectRunsStat || noProjectRunsStat.isDirectory()) &&
    !projects.some((project) => project.runsDir === noProjectRuns)
  )
    projects.push({
      root: noProjectRoot,
      runsDir: noProjectRuns,
      reviewsDir: null,
      keepLastRuns: true,
    });
  return projects;
}

async function optionalStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
