// Minimal D1Database stand-in backed by node:sqlite, for running tests on
// machines where workerd/miniflare can't run (needs macOS 13.5+). D1 is
// SQLite, so the dialect matches; only the D1 client surface used by src/db.ts
// is implemented. Real D1 behavior is verified by the deploy smoke test.
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function createTestDb(): D1Database {
  const db = new DatabaseSync(":memory:");
  const schema = readFileSync(
    path.join(here, "../migrations/0001_init.sql"),
    "utf8"
  );
  db.exec(schema);
  return { prepare: (sql: string) => statement(db, sql, []) } as D1Database;
}

function statement(
  db: DatabaseSync,
  sql: string,
  params: SQLInputValue[]
): D1PreparedStatement {
  return {
    bind: (...values: SQLInputValue[]) => statement(db, sql, values),
    async first<T>() {
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async all<T>() {
      return { results: db.prepare(sql).all(...params) as T[] };
    },
    async run() {
      const result = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  } as unknown as D1PreparedStatement;
}
