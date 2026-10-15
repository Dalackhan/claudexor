import type { DaemonFacadeClient, DaemonRunRecord } from "./run-record.js";

/** Batching bounds one RPC without capping the thread's lifetime or list. */
export async function readCommandIds(
  daemon: Pick<DaemonFacadeClient, "list">,
  ids: readonly string[],
): Promise<DaemonRunRecord[]> {
  const out: DaemonRunRecord[] = [];
  for (let i = 0; i < ids.length; i += 1000)
    out.push(...(await daemon.list({ ids: ids.slice(i, i + 1000) })));
  return out;
}

/** Thread bodies carry head ids, not command lifecycle; resolve heads only. */
export async function readThreadHeads(
  daemon: Pick<DaemonFacadeClient, "list">,
  threads: readonly unknown[],
): Promise<DaemonRunRecord[]> {
  const ids = threads.flatMap((thread) => {
    const id = (thread as { head_run_id?: unknown })?.head_run_id;
    return typeof id === "string" ? [id] : [];
  });
  return readCommandIds(daemon, [...new Set(ids)]);
}
