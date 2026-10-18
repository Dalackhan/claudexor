import { setImmediate as yieldToAdmission } from "node:timers/promises";
import type { EngineStore } from "./store.js";

// Connection-local observation, not a durable index or a second writer. TEMP
// triggers cover every SQL owner (including import/recovery and direct SQL).
// Rollbacks may cause extra reads; they cannot lose a protection.
const columns = {
  thread: ["id", "state", "body"],
  turn: ["id", "thread_id", "body"],
  session: ["id", "thread_id", "harness_id", "body"],
  command: [
    "id",
    "kind",
    "run_id",
    "run_dir",
    "state",
    "finished_at",
    "continue_from",
    "params_sha",
  ],
  interaction: ["id", "run_id", "state"],
  project: ["id", "pid", "root", "status", "current_pid"],
  partition: ["id", "name", "status", "project_id"],
  blob: ["sha256", "size", "inline"],
} as const;
type Table = keyof typeof columns;
type Change = { table: Table; id: string; operation: string };
type Listener = (change: Change) => void;
const observers = new WeakMap<EngineStore, Set<Listener>>();

function observe(store: EngineStore, listener: Listener): () => void {
  let listeners = observers.get(store);
  if (!listeners) {
    const targets = new Set<Listener>();
    store.db.function("disk_retention_changed", (table, id, operation) => {
      for (const target of targets)
        target({ table: table as Table, id: String(id), operation: String(operation) });
      return null;
    });
    for (const [table, fields] of Object.entries(columns)) {
      const key = fields[0];
      for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
        // New immutable bodies precede their command owner, whose INSERT is
        // observed. Only mutation/loss of an existing body needs a recheck.
        if (table === "blob" && operation === "INSERT") continue;
        const changed =
          operation === "UPDATE"
            ? `WHEN ${fields.map((field) => `OLD.${field} IS NOT NEW.${field}`).join(" OR ")}`
            : "";
        const rows =
          operation === "UPDATE" ? ["OLD", "NEW"] : [operation === "DELETE" ? "OLD" : "NEW"];
        store.exec(`CREATE TEMP TRIGGER disk_retention_${table}_${operation}
          AFTER ${operation} ON main.${table} ${changed} BEGIN
          ${rows.map((row) => `SELECT disk_retention_changed('${table}',${row}.${key},'${operation}');`).join("\n")}
          END`);
      }
    }
    observers.set(store, targets);
    listeners = targets;
  }
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Subscribe BEFORE the cooperative read. Drain changed row identities only;
 * quota/event traffic and unrelated metadata never restart the full inventory. */
export function retentionChanges(store: EngineStore) {
  const pending = new Map<string, Change>();
  let closed = false;
  let topologyChanged = false;
  let nativeChanged = false;
  const stop = observe(store, (change) => {
    pending.set(`${change.table}:${change.id}`, change);
    if (change.table === "project" || change.table === "partition") topologyChanged = true;
    // Even work that starts AND finishes during the file walk can write new
    // native sources. A final idle check alone would miss it.
    if (
      change.table === "command" ||
      change.table === "session" ||
      ((change.table === "thread" || change.table === "turn") && change.operation === "INSERT")
    )
      nativeChanged = true;
  });
  const readOne = (key: string, read: (change: Change) => void) => {
    const change = pending.get(key);
    if (!change) return;
    pending.delete(key);
    try {
      read(change);
    } catch (error) {
      topologyChanged = true;
      throw error;
    }
  };
  return {
    async refresh(read: (change: Change) => void) {
      // Capture a finite batch; newly arriving work is handled by the final
      // synchronous check or the next cooperative refresh.
      for (const key of [...pending.keys()]) {
        readOne(key, read);
        await yieldToAdmission();
      }
    },
    current(read: (change: Change) => void) {
      if (closed || topologyChanged) return false;
      // Same physical read budget as a SQL inventory page. An exceptional
      // burst stays for the next cooperative pass, never a long admission lock.
      if (pending.size > 100) return false;
      for (const key of pending.keys()) readOne(key, read);
      return !topologyChanged;
    },
    nativeCurrent: () => !nativeChanged,
    close() {
      closed = true;
      pending.clear();
      stop();
    },
  };
}
