import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Count an inode only when its last link is scheduled for removal. Dry runs
 * accumulate planned unlinks across trees; real deletion observes updated link counts. */
export function treeReclaimableBytes(root: string, removed: Map<string, number>): number {
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const stat = statSync(path);
        const key = `${stat.dev}:${stat.ino}`;
        const links = (removed.get(key) ?? 0) + 1;
        removed.set(key, links);
        if (links === stat.nlink) total += stat.size;
      }
    }
  };
  walk(root);
  return total;
}
