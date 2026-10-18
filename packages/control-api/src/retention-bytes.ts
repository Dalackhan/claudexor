import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Count an inode only when its last link is scheduled for removal. Dry runs
 * accumulate planned unlinks across trees; real deletion observes updated link counts. */
export async function treeReclaimableBytes(
  root: string,
  removed: Map<string, number>,
): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const info = await stat(path);
        const key = `${info.dev}:${info.ino}`;
        const links = (removed.get(key) ?? 0) + 1;
        removed.set(key, links);
        if (links === info.nlink) total += info.size;
      }
    }
  };
  await walk(root);
  return total;
}
