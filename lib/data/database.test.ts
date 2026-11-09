import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "./database.ts";

test("request connections require explicit migrations and never advance the schema", () => {
  const directory = mkdtempSync(join(tmpdir(), "emuly-schema-gate-"));
  const filename = join(directory, "app.db");
  try {
    assert.throws(() => openDatabase(filename, false), /Run pnpm db:migrate/);
    const unchanged = new DatabaseSync(filename);
    assert.equal(unchanged.prepare("PRAGMA user_version").get()?.user_version, 0);
    assert.equal(unchanged.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()?.n, 0);
    unchanged.close();
    openDatabase(filename).close();
    openDatabase(filename, false).close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("migrate applies a migration added after the connection was opened", () => {
  const dir = mkdtempSync(join(tmpdir(), "emuly-db-"));
  const database = openDatabase(join(dir, "app.db"));
  try {
    const { user_version: latest } = database.prepare("PRAGMA user_version").get() as { user_version: number };
    // Simulate a connection opened before the latest migration existed.
    database.exec(`CREATE TABLE backups (id INTEGER PRIMARY KEY); PRAGMA user_version = ${latest - 1}`);
    migrate(database);
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, latest);
    assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'backups'").get()?.n, 0);
    migrate(database); // no-op when current
  } finally {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration 5 preserves saved allowances from v4 as explicit overrides", () => {
  const directory = mkdtempSync(join(tmpdir(), "emuly-billing-migration-"));
  const filename = join(directory, "test.db");
  let database = new DatabaseSync(filename);
  try {
    database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE user_settings (user_id INTEGER PRIMARY KEY REFERENCES users(id), allowance_core_hours REAL NOT NULL DEFAULT 120);
      CREATE TABLE phones (id TEXT PRIMARY KEY, codespace_name TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO users VALUES (1), (2);
      INSERT INTO user_settings VALUES (1, 120), (2, 200);
      PRAGMA user_version = 4;`);
    database.close();
    database = openDatabase(filename);
    assert.deepEqual(database.prepare("SELECT user_id, allowance_override FROM billing_settings ORDER BY user_id").all()
      .map(row => ({ ...row })), [{ user_id: 1, allowance_override: 120 }, { user_id: 2, allowance_override: 200 }]);
    database.exec("DELETE FROM user_settings WHERE user_id = 1; DELETE FROM users WHERE id = 1;");
    assert.equal(database.prepare("SELECT count(*) AS n FROM billing_settings").get()?.n, 1);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

// Independent v1 fixture: a deployed database must upgrade without rebuilding its rows.
const v1 = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, github_id INTEGER NOT NULL UNIQUE, login TEXT NOT NULL, name TEXT, avatar_url TEXT,
    token_cipher BLOB NOT NULL, token_expires_at TEXT, refresh_cipher BLOB, refresh_expires_at TEXT,
    token_scopes TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE TABLE phones (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    codespace_name TEXT NOT NULL UNIQUE, codespace_id TEXT, repo_full_name TEXT NOT NULL, machine TEXT NOT NULL,
    state TEXT NOT NULL, state_detail TEXT, created_at TEXT NOT NULL, last_started_at TEXT,
    last_stopped_at TEXT, retention_at TEXT, runner_secret BLOB NOT NULL
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY, phone_id TEXT REFERENCES phones(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, meta TEXT
  );
  CREATE TABLE backups (
    id INTEGER PRIMARY KEY, phone_id TEXT NOT NULL REFERENCES phones(id) ON DELETE CASCADE,
    generation TEXT NOT NULL, bytes INTEGER, sha256 TEXT, created_at TEXT NOT NULL, verified_at TEXT
  );
  CREATE TABLE usage_snapshots (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, ts TEXT NOT NULL, core_hours REAL, storage_mb REAL, source TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX phones_user ON phones(user_id);
  CREATE INDEX events_phone_ts ON events(phone_id, ts DESC);
  PRAGMA user_version = 1;
`;

test("migrations preserve v1 phones, credentials, sessions and history; defaults and cascades survive reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "emuly-v2-"));
  const filename = join(directory, "test.db");
  let database = new DatabaseSync(filename);
  try {
    database.exec(v1);
    database.prepare(`INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
      VALUES (1, 11, 'synthetic-user', ?, 'codespace', '2026-11-01', '2026-11-01')`).run(Buffer.from("sealed-token"));
    database.prepare(`INSERT INTO phones (id, user_id, codespace_name, codespace_id, repo_full_name, machine, state,
      created_at, last_stopped_at, retention_at, runner_secret)
      VALUES ('phone-aaaa', 1, 'github-generated', '123', 'fixture/template', 'fixture-machine', 'stopped',
      '2026-11-01', '2026-11-06', '2026-11-13', ?)`).run(Buffer.from("sealed-runner"));
    database.exec(`INSERT INTO sessions VALUES ('hashed-session', 1, '2026-11-01', '2026-12-01');
      INSERT INTO events (phone_id, user_id, ts, kind, message) VALUES ('phone-aaaa', 1, '2026-11-01', 'action', 'old history');
      INSERT INTO backups (phone_id, generation, created_at) VALUES ('phone-aaaa', 'gen-1', '2026-11-01');`);
    const user = database.prepare("SELECT * FROM users").get();
    const phone = database.prepare("SELECT * FROM phones").get();
    database.prepare(`INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, state,
      created_at, runner_secret) VALUES ('phone-bbbb', 1, 'pending:phone-bbbb', 'fixture/template',
      'fixture-machine', 'error', '2026-11-02', ?)`).run(Buffer.from("sealed-pending-runner"));
    database.close();
    database = openDatabase(filename);
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 11);
    assert.deepEqual({ ...database.prepare("SELECT * FROM phone_creations").get() }, {
      phone_id: "phone-bbbb", display_name: "phone-bbbb", outcome: "unconfirmed", requested_at: "2026-11-02",
    });
    assert.deepEqual(database.prepare("SELECT * FROM users").get(), user);
    const { idle_timeout_min, cores, retention_min, stop_reason, android_state, android_started_at, android_error, ...preserved } = database.prepare("SELECT * FROM phones WHERE id = 'phone-aaaa'").get()!;
    assert.deepEqual([android_state, android_started_at, android_error], ["idle", null, null]);
    assert.equal(stop_reason, null);
    assert.deepEqual(preserved, { ...phone });
    assert.deepEqual([idle_timeout_min, cores, retention_min], [240, null, 43200]);
    assert.equal(database.prepare("SELECT id FROM sessions").get()?.id, "hashed-session");
    assert.equal(database.prepare("SELECT message FROM events").get()?.message, "old history");
    assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'backups'").get()?.n, 0);
    database.exec(`INSERT INTO user_settings (user_id) VALUES (1);
      INSERT INTO phone_keeps VALUES ('phone-aaaa', 'starting', '2026-11-07', NULL);
      INSERT INTO runs (phone_id, cores, started_at, source) VALUES ('phone-aaaa', 4, '2026-11-07', 'emuly');
      INSERT INTO notices VALUES (1, 'hours.low', '2026-11');`);
    assert.deepEqual({ ...database.prepare("SELECT * FROM user_settings").get() }, {
      user_id: 1, allowance_core_hours: 120, default_machine: null, default_idle_min: 30,
      auto_stop_before_empty: 0, auto_keep: 0,
    });
    assert.throws(() => database.exec("INSERT INTO notices VALUES (1, 'hours.low', '2026-11')"));
    database.prepare(`INSERT INTO webhooks (id, user_id, url, events, secret_cipher, created_at)
      VALUES ('wh-test', 1, 'https://receiver.invalid', '*', ?, '2026-11-07')`).run(Buffer.from("sealed-webhook"));
    database.exec(`INSERT INTO webhook_deliveries (id, webhook_id, event_id, type, body, state)
      VALUES ('delivery-test', 'wh-test', 'evt-test', 'webhook.test', '{}', 'pending');`);
    assert.equal(database.prepare("SELECT attempt FROM webhook_deliveries").get()?.attempt, 0);
    assert.equal(database.prepare("SELECT enabled FROM webhooks").get()?.enabled, 1);
    const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(row => row.name);
    assert.ok(indexes.includes("runs_phone"));
    assert.ok(indexes.includes("deliveries_due"));
    database.close();
    database = openDatabase(filename);
    assert.equal(database.prepare("SELECT count(*) AS n FROM runs").get()?.n, 1);
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 11);
    assert.equal(database.prepare("SELECT count(*) AS n FROM phone_creations").get()?.n, 1);
    assert.equal(database.prepare("SELECT phase FROM phone_keeps").get()?.phase, "starting");
    database.exec("DELETE FROM users WHERE id = 1");
    for (const table of ["phones", "phone_creations", "runs", "phone_keeps", "user_settings", "webhooks", "webhook_deliveries"]) {
      assert.equal(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0);
    }
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
