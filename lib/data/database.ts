import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MIGRATIONS } from "./migrations.ts";

export function openDatabase(filename: string, applyMigrations = true): DatabaseSync {
  const path = resolve(filename);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  try {
    if (applyMigrations) migrate(db);
    else if (Number(db.prepare("PRAGMA user_version").get()?.user_version) !== MIGRATIONS.length) {
      throw new Error("Database migrations required. Run pnpm db:migrate before starting the app.");
    }
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

/** Applies pending migrations. Safe to call again on an open connection (e.g. after dev hot reload). */
export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version > MIGRATIONS.length) {
    throw new Error("Database schema is newer than this application");
  }
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

