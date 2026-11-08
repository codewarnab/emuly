import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal, open } from "./crypto-core.ts";
import { openDatabase } from "../data/database.ts";
import { insertSession, readSession, deleteSession } from "./session-store.ts";

test("encryption survives serialization and rejects tampered boxes and wrong keys", () => {
  const key = randomBytes(32).toString("base64");
  const box = seal("test credential", key);
  assert.equal(open(new Uint8Array(box), key), "test credential");
  assert.notDeepEqual(seal("test credential", key), box);
  for (const offset of [0, 1, 13, 29]) {
    const changed = Buffer.from(box);
    changed[offset] ^= 1;
    assert.throws(() => open(changed, key));
  }
  assert.throws(() => open(box, randomBytes(32).toString("base64")));
  assert.throws(() => open(box.subarray(0, 10), key));
});

test("migrations preserve existing users and sessions on reopen; cookies never persist", () => {
  const directory = mkdtempSync(join(tmpdir(), "phonelink-test-"));
  const filename = join(directory, "test.db");
  let db = openDatabase(filename);
  try {
    db.prepare(`INSERT INTO users (github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
      VALUES (123, 'test-user', ?, 'codespace', ?, ?)`).run(Buffer.from("sealed-fixture"), "2026-01-01", "2026-01-01");
    const user = db.prepare("SELECT id FROM users").get() as { id: number };
    const session = insertSession(db, user.id);
    const stored = db.prepare("SELECT id, expires_at FROM sessions").get() as { id: string; expires_at: string };
    assert.notEqual(stored.id, session.value);
    assert.equal(stored.id, createHash("sha256").update(session.value).digest("base64url"));
    assert.ok(Date.parse(stored.expires_at) > Date.now() + 29 * 24 * 60 * 60_000);
    const version = db.prepare("PRAGMA user_version").get();
    db.close();
    db = openDatabase(filename);
    assert.deepEqual(db.prepare("PRAGMA user_version").get(), version);
    assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
    assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
    assert.equal(db.prepare("PRAGMA busy_timeout").get()?.timeout, 5000);
    assert.equal(readSession(db, session.value)?.userId, user.id);
    assert.equal(readSession(db, randomBytes(32).toString("base64url")), null);
    assert.equal(readSession(db, "malformed"), null);
    db.prepare("UPDATE sessions SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
    assert.equal(readSession(db, session.value), null);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get()?.n, 0);
    const blocked = insertSession(db, user.id);
    db.prepare("UPDATE users SET blocked = 1 WHERE id = ?").run(user.id);
    assert.equal(readSession(db, blocked.value), null);
    db.prepare("UPDATE users SET blocked = 0 WHERE id = ?").run(user.id);
    const logout = insertSession(db, user.id);
    deleteSession(db, logout.value);
    assert.equal(readSession(db, logout.value), null);
    assert.throws(() => insertSession(db, user.id + 1));
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
