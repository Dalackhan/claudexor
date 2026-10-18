import type { EngineStore } from "./store.js";

/** Quarantine completes recovery: those rows are evidence, never live owners.
 * Archived generations remain restorable owners. Unknown/pending states cannot
 * prove absence and hold run retirement install-wide. */
export function retentionGenerations(store: EngineStore) {
  const rows = store
    .prepare(
      `SELECT q.id,q.name,q.status,q.project_id,p.root,g.status AS registry_status FROM partition q
    LEFT JOIN project p ON p.id=q.project_id LEFT JOIN partition g ON g.id=p.pid`,
    )
    .all() as Array<{
    id: number;
    name: string;
    status: string;
    root: string | null;
    project_id: string | null;
    registry_status: string | null;
  }>;
  const known = new Map(rows.map((row) => [row.id, row]));
  // A completed global quarantine also retires its project descendants. Their
  // own ready/archived/pending bits are historical, not an independent owner.
  const retired = (row: (typeof rows)[number]) =>
    row.status === "quarantined" || row.registry_status === "quarantined";
  const retained = (pid: number) => {
    const row = known.get(pid);
    if (!row) throw new Error(`retention owner names missing partition ${pid}`);
    return (
      !retired(row) &&
      (!row.project_id || row.registry_status === "ready" || row.registry_status === "archived") &&
      (row.status === "ready" || row.status === "archived")
    );
  };
  const registered = store
    .prepare(
      `SELECT p.root FROM project p
    JOIN partition g ON g.id=p.pid LEFT JOIN partition q ON q.id=p.current_pid
    WHERE p.status IN ('active','archived') AND g.status IN ('ready','archived')
      AND (q.id IS NULL OR q.status<>'quarantined')`,
    )
    .all() as Array<{ root: string }>;
  const registeredProjectRoots = new Set(registered.map((row) => row.root));
  const protectedProjectRoots = new Set<string>();
  const errors: string[] = [];
  let blocked: string | undefined;
  for (const row of rows) {
    if (retained(row.id) || retired(row)) continue;
    const reason = `partition ${row.name} (${row.id}, ${row.status}) awaits journal recovery`;
    // Scope roots do not bound dependencies: a continuation may name any namespace.
    blocked ??= reason;
    errors.push(`all namespaces kept: ${reason}`);
  }
  for (const row of store
    .prepare(
      `SELECT p.root,p.current_pid FROM project p
    JOIN partition g ON g.id=p.pid LEFT JOIN partition q ON q.id=p.current_pid
    WHERE g.status IN ('ready','archived') AND q.id IS NULL`,
    )
    .all() as Array<{
    root: string;
    current_pid: number;
  }>) {
    protectedProjectRoots.add(row.root);
    errors.push(
      `namespace ${row.root} kept: missing partition ${row.current_pid} awaits journal recovery`,
    );
  }
  return { retained, registeredProjectRoots, protectedProjectRoots, errors, blocked };
}
