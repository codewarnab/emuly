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
  `
  ALTER TABLE phones ADD COLUMN idle_timeout_min INTEGER NOT NULL DEFAULT 240;
  ALTER TABLE phones ADD COLUMN cores INTEGER;
  ALTER TABLE phones ADD COLUMN retention_min INTEGER NOT NULL DEFAULT 43200;

  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    phone_id TEXT NOT NULL REFERENCES phones(id) ON DELETE CASCADE,
    cores INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    stopped_at TEXT,
    source TEXT NOT NULL
  );
  CREATE INDEX runs_phone ON runs(phone_id, started_at);
  CREATE TABLE user_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    allowance_core_hours REAL NOT NULL DEFAULT 120,
    default_machine TEXT,
    default_idle_min INTEGER NOT NULL DEFAULT 30,
    auto_stop_before_empty INTEGER NOT NULL DEFAULT 0,
    auto_keep INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE notices (
    user_id INTEGER NOT NULL, kind TEXT NOT NULL, period TEXT NOT NULL,
    PRIMARY KEY (user_id, kind, period)
  );
  CREATE TABLE webhooks (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    events TEXT NOT NULL,
    secret_cipher BLOB NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    failing_since TEXT
  );
  CREATE TABLE webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    type TEXT NOT NULL,
    body TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    next_try_at TEXT,
    status INTEGER,
    duration_ms INTEGER,
    state TEXT NOT NULL
  );
  CREATE INDEX deliveries_due ON webhook_deliveries(state, next_try_at);
  `,
  `
  CREATE TABLE phone_keeps (
    phone_id TEXT PRIMARY KEY REFERENCES phones(id) ON DELETE CASCADE,
    phase TEXT NOT NULL CHECK (phase IN ('starting', 'stopping')),
    requested_at TEXT NOT NULL,
    attempted_at TEXT
  );
  `,
  `
  ALTER TABLE webhook_deliveries ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
  ALTER TABLE webhook_deliveries ADD COLUMN attempted_at TEXT;
  ALTER TABLE phones ADD COLUMN stop_reason TEXT;
  `,
  `
  CREATE TABLE billing_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    plan_name TEXT,
    allowance_override REAL
  );
  -- Preserve existing saved allowances; future machine-only saves stay automatic.
  INSERT INTO billing_settings (user_id, allowance_override)
    SELECT user_id, allowance_core_hours FROM user_settings;
  `,
  `
  CREATE TABLE phone_creations (
    phone_id TEXT PRIMARY KEY REFERENCES phones(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL UNIQUE,
    outcome TEXT NOT NULL CHECK (outcome IN ('unconfirmed', 'confirmed', 'failed')),
    requested_at TEXT NOT NULL
  );
  -- Old pending identifiers may already refer to a Codespace whose response was lost.
  INSERT INTO phone_creations (phone_id, display_name, outcome, requested_at)
    SELECT id, id, 'unconfirmed', created_at FROM phones
    WHERE codespace_name LIKE 'pending:%' AND state != 'deleted';
  `,
  `
  ALTER TABLE phones ADD COLUMN android_state TEXT NOT NULL DEFAULT 'idle';
  ALTER TABLE phones ADD COLUMN android_started_at TEXT;
  ALTER TABLE phones ADD COLUMN android_error TEXT;
  `,
  `
  CREATE TABLE display_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    stream_quality TEXT NOT NULL DEFAULT 'auto' CHECK (stream_quality IN ('auto', 'sharp', 'saver'))
  );
  `,
  `
  CREATE TABLE diagnostic_operations (
    id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone_id TEXT NOT NULL REFERENCES phones(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL, kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
    outcome TEXT NOT NULL DEFAULT 'running', schema_version INTEGER NOT NULL DEFAULT 1,
    instrumentation_version INTEGER NOT NULL DEFAULT 1, release TEXT NOT NULL, observer_id TEXT NOT NULL,
    dropped_records INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE diagnostic_phone_runs (
    phone_id TEXT PRIMARY KEY REFERENCES phones(id) ON DELETE CASCADE, run_id TEXT NOT NULL
  );
  CREATE TABLE diagnostic_health (code TEXT PRIMARY KEY, count INTEGER NOT NULL);
  CREATE INDEX diagnostic_owner ON diagnostic_operations(owner_id, phone_id, started_at);
  CREATE INDEX diagnostic_retention ON diagnostic_operations(started_at, outcome);
  CREATE TABLE diagnostic_steps (
    operation_id TEXT NOT NULL REFERENCES diagnostic_operations(id) ON DELETE CASCADE,
    step_id TEXT NOT NULL, producer TEXT NOT NULL, producer_run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL, code TEXT NOT NULL, attempt INTEGER NOT NULL,
    outcome TEXT NOT NULL, observed_at TEXT NOT NULL, record TEXT NOT NULL CHECK(length(record) <= 2048),
    PRIMARY KEY(operation_id, step_id), UNIQUE(operation_id, producer, producer_run_id, sequence)
  );
  CREATE INDEX diagnostic_steps_status ON diagnostic_steps(operation_id, outcome);
  CREATE TABLE diagnostic_cursors (
    operation_id TEXT NOT NULL REFERENCES diagnostic_operations(id) ON DELETE CASCADE,
    producer_run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    PRIMARY KEY(operation_id, producer_run_id)
  );
  CREATE TABLE diagnostic_daily (
    day TEXT NOT NULL, release TEXT NOT NULL, code TEXT NOT NULL, outcome TEXT NOT NULL,
    quality TEXT NOT NULL, disposition TEXT NOT NULL, boot_method TEXT NOT NULL,
    cause TEXT NOT NULL, confidence TEXT NOT NULL, bucket_ms INTEGER NOT NULL, samples INTEGER NOT NULL,
    PRIMARY KEY(day, release, code, outcome, quality, disposition, boot_method, cause, confidence, bucket_ms)
  );
  CREATE TABLE phone_setup_attempts (
    phone_id TEXT PRIMARY KEY REFERENCES phones(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0, operation_id TEXT, attempt_id TEXT NOT NULL
  );
  CREATE TABLE poller_retries (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    retry_at INTEGER NOT NULL, error_code TEXT NOT NULL
  );
  `,
];

export function openDatabase(filename: string): DatabaseSync {
  const path = resolve(filename);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  try {
    migrate(db);
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

