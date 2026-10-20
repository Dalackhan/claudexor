import type { DatabaseSync } from "node:sqlite";

/**
 * Connection pragmas of the engine store (SYNTHESIS_R5 §2, topology A2).
 *
 * Main connection: WAL + NORMAL, no automatic checkpoints and no full-device
 * syncs. A COMMIT that restarts the WAL still syncs its new header, using plain
 * fsync rather than F_FULLFSYNC on macOS. The flusher alone checkpoints, with
 * checkpoint_fullfsync=1: synchronized backfill precedes reuse, and its explicit
 * WAL barrier still proves committed state durable across power loss. A pinned
 * reader or large transaction can grow the WAL until the flusher can reclaim it.
 * The busy timeout is a fuse, counted by `busy_waits`.
 *
 * Flusher connection: never writes rows, never waits for a lock (PASSIVE
 * checkpoints never wait for readers), retains the full checkpoint sync class.
 */
export interface PragmaSpec {
  readonly [name: string]: number | string;
}

export const MAIN_CONNECTION_PRAGMAS: PragmaSpec = Object.freeze({
  journal_mode: "wal",
  synchronous: 1,
  wal_autocheckpoint: 0,
  checkpoint_fullfsync: 0,
  fullfsync: 0,
  journal_size_limit: 67108864,
  busy_timeout: 5000,
  temp_store: 2,
  page_size: 4096,
  auto_vacuum: 0,
});

export const FLUSHER_CONNECTION_PRAGMAS: PragmaSpec = Object.freeze({
  checkpoint_fullfsync: 1,
  fullfsync: 0,
  busy_timeout: 0,
});

/** Human spellings SQLite accepts on assignment for the symbolic pragmas. */
const ASSIGNMENT_VALUE: Record<string, Record<string, string>> = {
  journal_mode: { wal: "WAL" },
  synchronous: { "1": "NORMAL" },
  temp_store: { "2": "MEMORY" },
  auto_vacuum: { "0": "NONE" },
};

/** `PRAGMA busy_timeout` reads back under the column name `timeout`. */
const READBACK_COLUMN: Record<string, string> = { busy_timeout: "timeout" };

export class PragmaReadbackError extends Error {
  constructor(
    readonly pragma: string,
    readonly expected: number | string,
    readonly actual: unknown,
  ) {
    super(`PRAGMA ${pragma} read back ${JSON.stringify(actual)}, expected ${expected}`);
    this.name = "PragmaReadbackError";
  }
}

/** Apply every pragma, then prove each one by reading it back. */
export function applyPragmas(db: DatabaseSync, spec: PragmaSpec): Record<string, number | string> {
  for (const [name, value] of Object.entries(spec)) {
    const spelled = ASSIGNMENT_VALUE[name]?.[String(value)] ?? String(value);
    db.exec(`PRAGMA ${name}=${spelled}`);
  }
  return readPragmas(db, spec);
}

/** Read the named pragmas back and compare against the spec. */
export function readPragmas(db: DatabaseSync, spec: PragmaSpec): Record<string, number | string> {
  const observed: Record<string, number | string> = {};
  for (const [name, expected] of Object.entries(spec)) {
    const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
    const column = READBACK_COLUMN[name] ?? name;
    const actual = row?.[column];
    const normalized =
      typeof actual === "string"
        ? actual.toLowerCase()
        : typeof actual === "bigint"
          ? Number(actual)
          : actual;
    if (normalized !== expected) throw new PragmaReadbackError(name, expected, actual);
    observed[name] = normalized as number | string;
  }
  return observed;
}
