import { setImmediate as yieldToAdmission } from "node:timers/promises";
import type { EngineStore } from "./store.js";

/** Bound each synchronous SQLite read, without holding a cursor/transaction
 * across admission. Filter after paging so a sparse predicate cannot turn one
 * page into an unbounded scan. This is an I/O batch, not a retention policy. */
export async function* retentionPages<T>(
  store: EngineStore,
  table: "thread" | "command",
  columns: string,
): AsyncGenerator<T[]> {
  const page = store.prepare(
    `SELECT rowid AS retention_rowid,${columns} FROM ${table} NOT INDEXED
     WHERE rowid>? ORDER BY rowid LIMIT 100`,
  );
  let after = 0;
  for (;;) {
    const rows = page.all(after) as Array<T & { retention_rowid: number }>;
    if (!rows.length) return;
    yield rows;
    after = rows[rows.length - 1]!.retention_rowid;
    await yieldToAdmission();
  }
}
