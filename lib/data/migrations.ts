// Frozen column list for the dashboard change-counter migration. Keep future
// changes to the dashboard projection in a new migration.
const dashboardPhoneColumns = [
  "id", "user_id", "codespace_name", "machine", "state", "state_detail", "created_at", "retention_at",
  "idle_timeout_min", "last_started_at", "last_stopped_at", "cores", "retention_min", "android_state",
  "android_started_at", "android_error", "device_preset", "last_activity_at",
];

function bumpDashboardVersion(owner: string, when = "1") {
  // Events have no user foreign key. Cascading deletes can also run after the owner is gone.
  return `INSERT INTO user_changes (user_id, version)
    SELECT id, 1 FROM users WHERE id = (${owner}) AND (${when})
    ON CONFLICT(user_id) DO UPDATE SET version = user_changes.version + 1;`;
}

const oldPhoneOwner = "SELECT user_id FROM phones WHERE id = OLD.phone_id";
const newPhoneOwner = "SELECT user_id FROM phones WHERE id = NEW.phone_id";

/** Ordered migrations. Index + 1 = PRAGMA user_version after it runs. Append only. */
export const MIGRATIONS = [
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
  `CREATE TABLE coordination_leases (
    resource TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE stream_tickets (
    hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone_id TEXT NOT NULL REFERENCES phones(id) ON DELETE CASCADE, session_id TEXT NOT NULL,
    origin TEXT NOT NULL, cookie_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE app_admissions (
    phone_id TEXT PRIMARY KEY REFERENCES phones(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_key TEXT NOT NULL, expires_at INTEGER NOT NULL
  );`,
  // The backups feature was never built (no keep.sh, no writer). Drop its empty table.
  `DROP TABLE IF EXISTS backups;`,
  `
  CREATE TABLE IF NOT EXISTS agent_setup_codes (
    code_hash  TEXT PRIMARY KEY,   -- sha256 of the one-time code, never the code itself
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS agent_setup_codes_user ON agent_setup_codes(user_id);

  CREATE TABLE IF NOT EXISTS agent_keys (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE, -- sha256 of the bearer key, never the key itself
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    expires_at   TEXT NOT NULL,
    revoked_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS agent_keys_user ON agent_keys(user_id);
  `,
  `
  CREATE TABLE IF NOT EXISTS agent_device_codes (
    device_code_hash TEXT PRIMARY KEY,       -- sha256 of the long device code, never the code itself
    user_code        TEXT NOT NULL,          -- short code the user types or approves
    status           TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'used')),
    user_id          INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at       TEXT NOT NULL,
    expires_at       TEXT NOT NULL,
    last_polled_at   TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS agent_device_codes_pending_code
    ON agent_device_codes(user_code) WHERE status = 'pending';
  `,
  `
  ALTER TABLE user_settings ADD COLUMN agent_delete_phones INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS phone_delete_requests (
    id           TEXT PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,  -- sha256 of the approval token, never the token itself
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone_id     TEXT NOT NULL,  -- kept after the phone is deleted so polling can report done
    agent_key_id INTEGER REFERENCES agent_keys(id) ON DELETE SET NULL,
    status       TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'done')),
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS phone_delete_requests_user ON phone_delete_requests(user_id, phone_id);
  CREATE INDEX IF NOT EXISTS phone_delete_requests_pending ON phone_delete_requests(status, expires_at);

  CREATE TABLE IF NOT EXISTS agent_phone_deletions (
    id             INTEGER PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone_name     TEXT NOT NULL,
    agent_key_name TEXT NOT NULL,
    deleted_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_phone_deletions_user ON agent_phone_deletions(user_id, deleted_at DESC);
  `,
  // The proxy token is stored as a digest; NULL means the agent must ask GET /agent-device again.
  `ALTER TABLE phones ADD COLUMN agent_device_token_hash TEXT;`,
  `
  CREATE TABLE IF NOT EXISTS rate_limit_hits (
    bucket TEXT NOT NULL,
    key TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rate_limit_hits_bucket_key_ts ON rate_limit_hits(bucket, key, ts);
  CREATE INDEX IF NOT EXISTS rate_limit_hits_ts ON rate_limit_hits(ts);
  `,
  // Usage snapshots were never written or read. Hours come from the runs table and GitHub billing.
  `DROP TABLE IF EXISTS usage_snapshots;`,
  // The runner secret was for a codespace runner that was never built. Nothing read it.
  `ALTER TABLE phones DROP COLUMN runner_secret;`,
  // The last human or agent action. Emuly stops a phone that has had none for its idle time.
  `ALTER TABLE phones ADD COLUMN last_activity_at TEXT;`,
  // The /app/events stream reads max(id) for one user every 1.5 s. Without this index it scans all events.
  // The index holds the rowid (id), so max(id) for one user reads one index entry.
  `CREATE INDEX IF NOT EXISTS events_user ON events(user_id);`,
  // Screen preset id from lib/shared/device-presets.ts. boot.sh applies it to the AVD.
  `ALTER TABLE phones ADD COLUMN device_preset TEXT NOT NULL DEFAULT 'generic';`,
  // One-use tickets for a Route B link relay. Only the sha256 of the ticket is stored.
  `CREATE TABLE IF NOT EXISTS link_tickets (
    hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone_id TEXT NOT NULL REFERENCES phones(id) ON DELETE CASCADE, ports TEXT NOT NULL, expires_at INTEGER NOT NULL
  );`,
  // One row per user for the GitHub state sync (lib/phone/sync-gate.ts). Pages render from the database
  // and sync after the response; next_at keeps all server instances to one sync per interval.
  // error is a SyncError as JSON, or NULL after a good sync.
  `CREATE TABLE IF NOT EXISTS user_syncs (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    next_at INTEGER NOT NULL, synced_at INTEGER, error TEXT
  );
  CREATE TABLE IF NOT EXISTS scheduler_runs (
    name TEXT PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER, ok INTEGER NOT NULL DEFAULT 0
  );`,
  // When the user's browser last saw its network refuse *.app.github.dev (lib/phone/network-hint.ts).
  `CREATE TABLE IF NOT EXISTS user_network (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, direct_blocked_at INTEGER NOT NULL
  );`,
  // The idle timeout GitHub got for this codespace (PROVIDER_IDLE_MIN in lib/shared/idle.ts).
  // NULL for older phones: GitHub got idle_timeout_min for those.
  `ALTER TABLE phones ADD COLUMN provider_idle_min INTEGER;`,
  `CREATE TABLE user_changes (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    version INTEGER NOT NULL
  );
  CREATE TRIGGER dashboard_phone_insert AFTER INSERT ON phones BEGIN
    ${bumpDashboardVersion("NEW.user_id")}
  END;
  CREATE TRIGGER dashboard_phone_delete AFTER DELETE ON phones BEGIN
    ${bumpDashboardVersion("OLD.user_id")}
  END;
  CREATE TRIGGER dashboard_phone_update AFTER UPDATE OF ${dashboardPhoneColumns.join(", ")} ON phones
    WHEN ${dashboardPhoneColumns.map(column => `OLD.${column} IS NOT NEW.${column}`).join(" OR ")}
  BEGIN
    ${bumpDashboardVersion("NEW.user_id")}
    ${bumpDashboardVersion("OLD.user_id", "OLD.user_id IS NOT NEW.user_id")}
  END;

  CREATE TRIGGER dashboard_keep_insert AFTER INSERT ON phone_keeps BEGIN
    ${bumpDashboardVersion(newPhoneOwner)}
  END;
  CREATE TRIGGER dashboard_keep_delete AFTER DELETE ON phone_keeps BEGIN
    ${bumpDashboardVersion(oldPhoneOwner)}
  END;
  CREATE TRIGGER dashboard_keep_move AFTER UPDATE OF phone_id ON phone_keeps WHEN OLD.phone_id IS NOT NEW.phone_id BEGIN
    ${bumpDashboardVersion(newPhoneOwner)}
    ${bumpDashboardVersion(oldPhoneOwner, `(${oldPhoneOwner}) IS NOT (${newPhoneOwner})`)}
  END;

  CREATE TRIGGER dashboard_setup_insert AFTER INSERT ON phone_setup_attempts WHEN NEW.failed = 1 BEGIN
    ${bumpDashboardVersion(newPhoneOwner)}
  END;
  CREATE TRIGGER dashboard_setup_delete AFTER DELETE ON phone_setup_attempts WHEN OLD.failed = 1 BEGIN
    ${bumpDashboardVersion(oldPhoneOwner)}
  END;
  CREATE TRIGGER dashboard_setup_update AFTER UPDATE OF phone_id, failed ON phone_setup_attempts
    WHEN (OLD.failed = 1) IS NOT (NEW.failed = 1) OR OLD.phone_id IS NOT NEW.phone_id
  BEGIN
    ${bumpDashboardVersion(newPhoneOwner, "NEW.failed = 1")}
    ${bumpDashboardVersion(oldPhoneOwner, `OLD.failed = 1 AND (NEW.failed <> 1 OR (${oldPhoneOwner}) IS NOT (${newPhoneOwner}))`)}
  END;

  CREATE TRIGGER dashboard_sync_insert AFTER INSERT ON user_syncs WHEN NEW.error IS NOT NULL BEGIN
    ${bumpDashboardVersion("NEW.user_id")}
  END;
  CREATE TRIGGER dashboard_sync_delete AFTER DELETE ON user_syncs WHEN OLD.error IS NOT NULL BEGIN
    ${bumpDashboardVersion("OLD.user_id")}
  END;
  CREATE TRIGGER dashboard_sync_update AFTER UPDATE OF user_id, error ON user_syncs
    WHEN OLD.error IS NOT NEW.error OR OLD.user_id IS NOT NEW.user_id
  BEGIN
    ${bumpDashboardVersion("NEW.user_id", "NEW.error IS NOT NULL OR OLD.error IS NOT NULL AND OLD.user_id = NEW.user_id")}
    ${bumpDashboardVersion("OLD.user_id", "OLD.error IS NOT NULL AND OLD.user_id IS NOT NEW.user_id")}
  END;

  CREATE TRIGGER dashboard_event_insert AFTER INSERT ON events BEGIN
    ${bumpDashboardVersion("NEW.user_id")}
  END;
  CREATE TRIGGER dashboard_event_delete AFTER DELETE ON events BEGIN
    ${bumpDashboardVersion("OLD.user_id")}
  END;
  CREATE TRIGGER dashboard_event_update AFTER UPDATE OF user_id, id ON events
    WHEN OLD.user_id IS NOT NEW.user_id OR OLD.id IS NOT NEW.id
  BEGIN
    ${bumpDashboardVersion("NEW.user_id")}
    ${bumpDashboardVersion("OLD.user_id", "OLD.user_id IS NOT NEW.user_id")}
  END;`,
  // GitHub region of the codespace, for example "CentralIndia". Filled from GitHub on create and on each sync.
  `ALTER TABLE phones ADD COLUMN location TEXT;`,
  // Anonymous diagnostics. Operations no longer store owner_id or phone_id. The only link from a phone
  // to its records is phones.diagnostic_run_id, a random id for the current phone life. It changes on
  // each create or resume and goes away with the phone, so older records cannot be linked to anyone.
  // The old rows held ids, so they are deleted. The anonymous diagnostic_daily counts stay.
  `
  DELETE FROM diagnostic_cursors;
  DELETE FROM diagnostic_steps;
  DELETE FROM diagnostic_operations;
  DROP TABLE diagnostic_cursors;
  DROP TABLE diagnostic_steps;
  DROP TABLE diagnostic_operations;
  DROP TABLE diagnostic_phone_runs;
  CREATE TABLE diagnostic_operations (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
    outcome TEXT NOT NULL DEFAULT 'running', schema_version INTEGER NOT NULL DEFAULT 2,
    instrumentation_version INTEGER NOT NULL DEFAULT 1, release TEXT NOT NULL, observer_id TEXT NOT NULL,
    dropped_records INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX diagnostic_run ON diagnostic_operations(run_id, kind, outcome);
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
  ALTER TABLE phones ADD COLUMN diagnostic_run_id TEXT;
  `,
];
