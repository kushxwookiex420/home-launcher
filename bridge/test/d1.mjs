// A minimal D1 stand-in for the worker tests, backed by node:sqlite.
// Only the surface the worker uses is implemented: prepare().bind().run|first|all.

import { DatabaseSync } from "node:sqlite";

function statement(db, sql, args) {
  return {
    run() {
      const info = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    },
    first() {
      return db.prepare(sql).get(...args) ?? null;
    },
    all() {
      return { results: db.prepare(sql).all(...args), success: true };
    }
  };
}

export function makeD1() {
  const db = new DatabaseSync(":memory:");
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return statement(db, sql, args);
        },
        run() {
          return statement(db, sql, []).run();
        },
        first() {
          return statement(db, sql, []).first();
        },
        all() {
          return statement(db, sql, []).all();
        }
      };
    },
    exec(sql) {
      db.exec(sql);
    },
    raw: db
  };
}
