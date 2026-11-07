import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Ordered migrations. Index + 1 = PRAGMA user_version after it runs. Append only. */
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id                 INTEGER PRIMARY KEY,
    github_id          INTEGER NOT NULL UNIQUE,
    login              TEXT NOT NULL,
    name               TEXT,
    avatar_url         TEXT,
    token_cipher       BLOB NOT NULL,
    token_expires_at   TEXT,
    refresh_cipher     BLOB,
    refresh_expires_at TEXT,
    token_scopes       TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    last_seen_at       TEXT NOT NULL,
    blocked            INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,   -- sha256 of the cookie value, never the value itself
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE phones (
    id               TEXT PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    codespace_name   TEXT NOT NULL UNIQUE,
    codespace_id     TEXT,
    repo_full_name   TEXT NOT NULL,
    machine          TEXT NOT NULL,
    state            TEXT NOT NULL,
    state_detail     TEXT,
    created_at       TEXT NOT NULL,
    last_started_at  TEXT,
    last_stopped_at  TEXT,
    retention_at     TEXT,
    runner_secret    BLOB NOT NULL
  );
  CREATE INDEX phones_user ON phones(user_id);

  CREATE TABLE events (
    id        INTEGER PRIMARY KEY,
    phone_id  TEXT REFERENCES phones(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL,
    ts        TEXT NOT NULL,
    kind      TEXT NOT NULL,
    message   TEXT NOT NULL,
    meta      TEXT
  );
  CREATE INDEX events_phone_ts ON events(phone_id, ts DESC);

  CREATE TABLE backups (
    id           INTEGER PRIMARY KEY,
    phone_id     TEXT NOT NULL REFERENCES phones(id) ON DELETE CASCADE,
    generation   TEXT NOT NULL,
    bytes        INTEGER,
    sha256       TEXT,
    created_at   TEXT NOT NULL,
    verified_at  TEXT
  );

  CREATE TABLE usage_snapshots (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    ts          TEXT NOT NULL,
    core_hours  REAL,
    storage_mb  REAL,
    source      TEXT
  );
  `,
];

export function openDatabase(filename: string): DatabaseSync {
  const path = resolve(filename);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version > MIGRATIONS.length) {
    db.close();
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
  return db;
}

