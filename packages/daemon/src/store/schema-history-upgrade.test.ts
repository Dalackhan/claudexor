import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreSchemaUnsupportedError } from "./errors.js";
import { ENGINE_SCHEMA_VERSION, ensureSchema, readSchemaIdentity } from "./schema.js";

const sqlite = await import("node:sqlite").catch(() => null);
const roots: string[] = [];
const connections: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of connections.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function connect() {
  const root = mkdtempSync(join(tmpdir(), "cx-schema-v4-"));
  roots.push(root);
  const db = new sqlite!.DatabaseSync(join(root, "engine.sqlite"));
  connections.push(db);
  return db;
}

/** Exact v3 owner from 711cee0e5, not current DDL with an index removed. */
function version3Owner(): { ensureSchema(db: DatabaseSync): void } {
  const source = readFileSync(
    new URL("./test-support/fixtures/schema-v3.ts.txt", import.meta.url),
    "utf8",
  );
  const executable = stripTypeScriptTypes(source)
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "");
  return new Function(
    "randomUUID",
    "StoreSchemaUnsupportedError",
    `${executable}\nreturn { ensureSchema };`,
  )(randomUUID, StoreSchemaUnsupportedError);
}
function schema(db: DatabaseSync) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
}
function rows(db: DatabaseSync) {
  return Object.fromEntries(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map(({ name }) => [name, db.prepare(`SELECT * FROM ${name}`).all()]),
  );
}
function seed(db: DatabaseSync) {
  db.exec("INSERT INTO partition VALUES(1,'global','epoch','ready',2,NULL,'2026-10-26')");
  db.exec("INSERT INTO thread VALUES('thread',1,'active','2026-10-26',0,x'7b7d')");
  db.exec("INSERT INTO blob VALUES('prompt',2,x'6869')");
  db.exec(
    "INSERT INTO event(pid,seq,time,type,payload) VALUES(1,1,'2026-10-26','fixture',x'7b7d')",
  );
  const insert = db.prepare("INSERT INTO turn VALUES(?,1,'thread',?,?,'2026-10-26','prompt',?)");
  const bodies = [
    { answers_plan_run_id: "plan", run_id: "run" },
    { answers_plan_run_id: "plan", run_id: null },
    { answers_plan_run_id: "plan", enqueue_error: { retryable: true } },
    { answers_plan_run_id: "plan", enqueue_error: { retryable: false } },
    { answers_plan_run_id: null },
    {},
  ];
  bodies.forEach((body, i) =>
    insert.run(`turn-${i}`, i, i === 0 ? "run" : null, Buffer.from(JSON.stringify(body))),
  );
  for (const [i, body] of [
    Buffer.from([0]),
    Buffer.from('{"answers_plan_run_id":'),
    Buffer.from("null"),
  ].entries())
    insert.run(`raw-${i}`, bodies.length + i, null, body);
}
function assertIndex(db: DatabaseSync) {
  const index = db.prepare("SELECT sql FROM sqlite_master WHERE name='turn_plan_answer'").get() as {
    sql: string;
  };
  expect(index.sql).toContain("CASE WHEN json_valid(CAST(body AS TEXT))");
  expect(index.sql).not.toContain("retryable");
  expect(index.sql).not.toContain("run_id IS NOT NULL");
  const columns = db.prepare("PRAGMA index_xinfo('turn_plan_answer')").all() as {
    cid: number;
    name: string | null;
    key: number;
  }[];
  expect(columns.filter((c) => c.key === 1).map((c) => [c.name, c.cid === -2])).toEqual([
    ["thread_id", false],
    [null, true],
    ["ordinal", false],
  ]);
  // Refusals occupy the index too. Null/missing/malformed relations never do.
  expect(
    db.prepare("SELECT sum(ncell) AS n FROM dbstat WHERE name='turn_plan_answer'").get(),
  ).toEqual({ n: 4 });
}

describe.skipIf(!sqlite)("thread-history schema v4", () => {
  it("creates a fresh v4 store and guards new writes with a minimal answer-present index", () => {
    const db = connect();
    ensureSchema(db);
    expect(ENGINE_SCHEMA_VERSION).toBe(4);
    expect(readSchemaIdentity(db).userVersion).toBe(4);
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: "4",
    });
    seed(db);
    assertIndex(db);
  });

  it("migrates a real populated v3 store without changing data or existing indexes", () => {
    const db = connect();
    version3Owner().ensureSchema(db);
    expect(readSchemaIdentity(db).userVersion).toBe(3);
    seed(db); // Invalid JSON and refusals predate index creation.
    const before = rows(db),
      previousSchema = schema(db);
    ensureSchema(db);
    expect(readSchemaIdentity(db).userVersion).toBe(4);
    expect({ ...rows(db), meta: [] }).toEqual({ ...before, meta: [] });
    expect(rows(db).meta).toEqual(
      (before.meta as { key: string; value: string }[]).map((row) =>
        row.key === "schema_version" ? { ...row, value: "4" } : row,
      ),
    );
    expect(schema(db).filter((row) => row.name !== "turn_plan_answer")).toEqual(previousSchema);
    assertIndex(db);
    const fresh = connect();
    ensureSchema(fresh);
    expect(schema(db)).toEqual(schema(fresh));
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    const exec = vi.spyOn(db, "exec");
    ensureSchema(db);
    expect(exec).not.toHaveBeenCalled();
    expect(() => version3Owner().ensureSchema(db)).toThrow(
      expect.objectContaining({ code: "store_schema_unsupported", userVersion: 4 }),
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it("rolls back a failed v3-to-v4 index creation and permits a subsequent upgrade", () => {
    const db = connect();
    version3Owner().ensureSchema(db);
    seed(db);
    const before = rows(db),
      previousSchema = schema(db);
    const exec = db.exec.bind(db);
    const fault = vi.spyOn(db, "exec").mockImplementation((sql) => {
      exec(sql);
      if (sql.includes("CREATE INDEX turn_plan_answer")) throw new Error("index failure");
    });
    expect(() => ensureSchema(db)).toThrow("index failure");
    fault.mockRestore();
    expect(readSchemaIdentity(db).userVersion).toBe(3);
    expect(rows(db)).toEqual(before);
    expect(schema(db)).toEqual(previousSchema);
    ensureSchema(db);
    assertIndex(db);
  });

  it("refuses a newer store before writes and still opens a current v4 store", () => {
    const db = connect();
    ensureSchema(db);
    seed(db);
    db.exec("PRAGMA user_version=5");
    const before = rows(db),
      previousSchema = schema(db);
    const exec = vi.spyOn(db, "exec");
    expect(() => ensureSchema(db)).toThrow(
      expect.objectContaining({ code: "store_schema_unsupported", userVersion: 5, status: 503 }),
    );
    expect(exec).not.toHaveBeenCalled();
    expect(rows(db)).toEqual(before);
    expect(schema(db)).toEqual(previousSchema);
    exec.mockRestore();
    db.exec("PRAGMA user_version=4"); // Fixture-only restoration of its original header.
    ensureSchema(db);
    assertIndex(db);
  });
});
