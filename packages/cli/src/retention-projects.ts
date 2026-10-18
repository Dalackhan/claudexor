import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { DiskRetentionReferences } from "@claudexor/daemon";
import type { RetentionProject } from "@claudexor/control-api";
import { projectRuntimeDir, userConfigDir } from "@claudexor/util";

/** Directory inventory owns reachability. Registrations with existing roots own
 * recent history; retained thread roots only name/protect references. */
export function retentionProjects(
  references: DiskRetentionReferences,
  noProjectRoot: string,
  healthyRoots: ReadonlySet<string>,
): RetentionProject[] {
  const projects: RetentionProject[] = [];
  const byHash = new Map(
    references.projectRoots.map((root) => [basename(projectRuntimeDir(root)), root]),
  );
  byHash.set(basename(projectRuntimeDir(noProjectRoot)), noProjectRoot);
  const ownedRoots = new Set([noProjectRoot]);
  for (const root of references.registeredProjectRoots) {
    try {
      if (statSync(root).isDirectory()) ownedRoots.add(root);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  const protectedHashes = new Set(
    [...references.protectedProjectRoots].map((root) => basename(projectRuntimeDir(root))),
  );
  const directory = join(userConfigDir(), "projects");
  if (existsSync(directory)) {
    if (!lstatSync(directory).isDirectory())
      throw new Error("retention projects directory is not a plain directory");
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (
        !/^[0-9a-f]{64}$/.test(entry.name) ||
        !entry.isDirectory() ||
        protectedHashes.has(entry.name)
      )
        continue;
      const runtime = join(directory, entry.name);
      const runsDir = join(runtime, "runs");
      if (existsSync(runsDir) && !lstatSync(runsDir).isDirectory()) continue;
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
  // A healthy repository can contain review debris before its first run.
  for (const root of healthyRoots) {
    if (
      references.protectedProjectRoots.has(root) ||
      projects.some((project) => project.root === root)
    )
      continue;
    const runtime = projectRuntimeDir(root);
    if (existsSync(runtime) && !lstatSync(runtime).isDirectory()) continue;
    const runsDir = new ArtifactStore(root).runsDir();
    if (existsSync(runsDir) && !lstatSync(runsDir).isDirectory()) continue;
    projects.push({
      root,
      runsDir,
      reviewsDir: join(root, ".claudexor", "reviews"),
      keepLastRuns: ownedRoots.has(root),
    });
  }
  const noProjectRuns = new ArtifactStore(noProjectRoot).runsDir();
  const noProjectRuntime = projectRuntimeDir(noProjectRoot);
  if (
    (!existsSync(noProjectRuntime) || lstatSync(noProjectRuntime).isDirectory()) &&
    (!existsSync(noProjectRuns) || lstatSync(noProjectRuns).isDirectory()) &&
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
