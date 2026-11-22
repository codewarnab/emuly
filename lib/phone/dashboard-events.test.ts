import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
import { eventStream, HEARTBEAT } from "../shared/event-stream.ts";
import { dashboardEventReader } from "./dashboard-events.ts";
import { readAgentActions } from "./agent-actions-feed.ts";

const session = { id: "test-session", userId: 1, expiresAt: "9999-01-01T00:00:00.000Z" };

async function fixture(t: { after(callback: () => void): void }) {
  const database = createClient({ url: "file::memory:" });
  t.after(() => database.close());
  await migrateHosted(database);
  await database.executeMultiple(`
    PRAGMA foreign_keys = ON;
    INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
    VALUES (1, 1, 'fixture', X'00', 'codespace', '2026-11-08', '2026-11-08'),
      (2, 2, 'other', X'00', 'codespace', '2026-11-08', '2026-11-08');
    INSERT INTO sessions (id, user_id, created_at, expires_at)
    VALUES ('test-session', 1, '2026-11-08', '9999-01-01T00:00:00.000Z');
  `);
  return database;
}

const createPhone = `INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, state, created_at)
  VALUES ('phone-aaaa', 1, 'fixture-space', 'fixture/template', 'fixture-machine', 'stopped', '2026-11-08')`;

test("dashboard sends changes and skips payload reads for irrelevant writes", async t => {
  const database = await fixture(t);
  let calls = 0;
  const read = dashboardEventReader({ execute: statement => {
    calls++;
    return database.execute(statement);
  } }, session);
  let poll = Promise.withResolvers<void>();
  const stream = eventStream(new Request("https://example.test/app/events"), async () => {
    await poll.promise;
    poll = Promise.withResolvers<void>();
    return read();
  }, { intervalMs: 0 });
  const reader = stream.body!.getReader();
  t.after(() => reader.cancel());
  const frame = async () => {
    poll.resolve();
    const result = await reader.read();
    return result.done ? undefined : new TextDecoder().decode(result.value);
  };
  const snapshot = async () => JSON.parse((await frame())!.slice(6));

  assert.deepEqual((await snapshot()).phones, []);
  let before = calls;
  assert.equal(await frame(), ": heartbeat\n\n");
  assert.equal(calls - before, 1);

  await database.execute(createPhone);
  assert.equal((await snapshot()).phones[0].state, "stopped");
  await database.execute("UPDATE phones SET state = 'running', android_state = 'ready'");
  assert.equal((await snapshot()).phones[0].android_state, "ready");

  await database.executeMultiple(`
    UPDATE phones SET agent_device_token_hash = 'changed', state = state;
    INSERT INTO phone_setup_attempts (phone_id, failed, attempt_id) VALUES ('phone-aaaa', 0, 'attempt');
    INSERT INTO user_syncs (user_id, next_at) VALUES (1, 0);
    UPDATE user_syncs SET error = NULL, next_at = 1, synced_at = 1 WHERE user_id = 1;
    INSERT INTO events (user_id, ts, kind, message) VALUES (2, '2026-11-08', 'step', 'Other user');
  `);
  before = calls;
  assert.equal(await frame(), ": heartbeat\n\n");
  assert.equal(calls - before, 1);

  await database.execute("UPDATE phones SET last_activity_at = '2026-11-08'");
  assert.equal((await snapshot()).phones[0].last_activity_at, "2026-11-08");
  await database.execute("UPDATE phone_setup_attempts SET failed = 1");
  assert.equal((await snapshot()).phones[0].setup_failed, 1);
  await database.execute("DELETE FROM phone_setup_attempts");
  assert.equal((await snapshot()).phones[0].setup_failed, 0);
  await database.execute("INSERT OR IGNORE INTO phone_keeps (phone_id, phase, requested_at) VALUES ('phone-aaaa', 'starting', '2026-11-08')");
  assert.equal((await snapshot()).phones[0].keeping, 1);
  await database.execute("DELETE FROM phone_keeps");
  assert.equal((await snapshot()).phones[0].keeping, 0);
  await database.execute("UPDATE phones SET state = 'stopped', android_state = 'idle'");
  assert.equal((await snapshot()).phones[0].state, "stopped");

  await database.execute("UPDATE user_syncs SET error = '{\"kind\":\"other\"}' WHERE user_id = 1");
  assert.deepEqual((await snapshot()).syncError, { kind: "other" });
  await database.execute("UPDATE user_syncs SET synced_at = synced_at + 1, error = error");
  before = calls;
  assert.equal(await frame(), ": heartbeat\n\n");
  assert.equal(calls - before, 1);
  await database.execute("UPDATE user_syncs SET error = NULL WHERE user_id = 1");
  assert.equal((await snapshot()).syncError, null);

  for (const id of [10, 11]) {
    await database.execute({ sql: "INSERT INTO events (id, phone_id, user_id, ts, kind, message) VALUES (?, 'phone-aaaa', 1, '2026-11-08', 'step', 'event')", args: [id] });
    assert.equal((await snapshot()).events[0].id, id);
  }
  before = calls;
  await database.execute("DELETE FROM events WHERE id = 10");
  assert.equal(await frame(), ": heartbeat\n\n");
  assert.equal(calls - before, 4, "a counter bump can leave the payload identical");
  await database.execute("DELETE FROM phones WHERE id = 'phone-aaaa'");
  const deleted = await snapshot();
  assert.deepEqual(deleted.phones, []);
  assert.equal(deleted.events[0].id, null);

  await database.execute("DELETE FROM sessions WHERE id = 'test-session'");
  assert.equal(await frame(), undefined);
});

test("dashboard rereads after a committed write during the snapshot and ignores a rollback", async t => {
  const database = await fixture(t);
  await database.execute(createPhone);
  let writeDuringRead = true;
  const read = dashboardEventReader({ execute: async statement => {
    const result = await database.execute(statement);
    if (writeDuringRead && typeof statement !== "string" && statement.sql.includes("FROM phones WHERE")) {
      writeDuringRead = false;
      await database.execute("UPDATE phones SET state = 'running'");
    }
    return result;
  } }, session);

  const before = await read();
  assert.ok(before && before !== HEARTBEAT);
  assert.equal(before.phones[0].state, "stopped");
  const after = await read();
  assert.ok(after && after !== HEARTBEAT);
  assert.equal(after.phones[0].state, "running");

  const tx = await database.transaction("write");
  try {
    await tx.execute("UPDATE phones SET state = 'stopped'");
    await tx.rollback();
  } finally { tx.close(); }
  assert.equal(await read(), HEARTBEAT);
  await database.execute("DELETE FROM users WHERE id = 1");
  assert.equal(await read(), undefined);
  assert.equal((await database.execute("SELECT user_id FROM user_changes WHERE user_id = 1")).rows.length, 0);
});

test("agent actions distinguish an empty poll from a revoked session", async t => {
  const database = await fixture(t);
  await database.execute(createPhone);
  assert.deepEqual(await readAgentActions(database, session, "phone-aaaa", 0), []);
  await database.execute(`INSERT INTO events (id, phone_id, user_id, ts, kind, message, meta)
    VALUES (3, 'phone-aaaa', 1, '2026-11-08', 'adb', 'tap', '{"action":{"type":"tap","x":1,"y":2}}')`);
  assert.deepEqual(await readAgentActions(database, session, "phone-aaaa", 0),
    [{ id: 3, at: "2026-11-08", action: { type: "tap", x: 1, y: 2 } }]);
  assert.deepEqual(await readAgentActions(database, session, "phone-aaaa", 3), []);
  assert.equal(await readAgentActions(database, { ...session, userId: 2 }, "phone-aaaa", 0), undefined);
  await database.execute("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'");
  assert.equal(await readAgentActions(database, session, "phone-aaaa", 0), undefined);
  await database.execute({ sql: "UPDATE sessions SET expires_at = ?", args: [session.expiresAt] });
  await database.execute("UPDATE users SET blocked = 1 WHERE id = 1");
  assert.equal(await readAgentActions(database, session, "phone-aaaa", 0), undefined);
});

test("a failed snapshot keeps the last successfully read dashboard version", async t => {
  const database = await fixture(t);
  let failSnapshot = false;
  const read = dashboardEventReader({ execute: statement => {
    if (failSnapshot && typeof statement !== "string" && statement.sql.includes("SELECT error FROM user_syncs")) {
      return Promise.reject(new Error("snapshot failed"));
    }
    return database.execute(statement);
  } }, session);

  assert.ok(await read());
  await database.execute(createPhone);
  failSnapshot = true;
  await assert.rejects(read(), /snapshot failed/);
  failSnapshot = false;
  const retry = await read();
  assert.ok(retry && retry !== HEARTBEAT);
  assert.equal(retry.phones[0].id, "phone-aaaa");
});
