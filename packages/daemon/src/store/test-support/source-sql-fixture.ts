import { join } from "node:path";
import { EngineStore } from "../store.js";
import { createPartition, currentGeneration } from "../partitions.js";
import { setGlobalGenerationInTx } from "../generations.js";
import { createSqlDaemonServices } from "../sql-daemon-services.js";
import { builtWorker } from "./resource-fixture.js";

/** Source integration fixture: no dependency on an earlier package build.
 * The existing worker is used only for its unchanged flushing protocol. */
export async function sourceSqlFixture(root: string) {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: builtWorker("flusher-worker.js"),
  });
  if (!currentGeneration(store, "global"))
    store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [root] });
  let closed = false;
  return {
    store,
    graph,
    async close() {
      if (closed) return;
      closed = true;
      await graph.close();
      await store.close();
    },
  };
}
