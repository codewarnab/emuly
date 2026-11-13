import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { seal, open, contexts, isLegacy } from "./crypto-core.ts";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
import { insertSession, readSession, deleteSession } from "./session-store.ts";

test("encryption survives serialization and rejects tampered boxes and wrong keys", () => {
  const key = randomBytes(32).toString("base64");
  const ctx = contexts.githubAccess(5);
  const box = seal("test credential", key, ctx);
  assert.equal(box[0], 2);
  assert.equal(open(new Uint8Array(box), key, ctx), "test credential");
  assert.notDeepEqual(seal("test credential", key, ctx), box);
  for (const offset of [0, 1, 13, 29]) {
    const changed = Buffer.from(box);
    changed[offset] ^= 1;
    assert.throws(() => open(changed, key, ctx));
  }
  assert.throws(() => open(box, randomBytes(32).toString("base64"), ctx));
  assert.throws(() => open(box.subarray(0, 10), key, ctx));
});

test("a value copied into another row or column does not decrypt", () => {
  const key = randomBytes(32).toString("base64");
  const box = seal("user five token", key, contexts.githubAccess(5));
  assert.throws(() => open(box, key, contexts.githubAccess(9)));
  assert.throws(() => open(box, key, contexts.githubRefresh(5)));
  assert.throws(() => open(box, key, ""));
});

test("legacy version 1 values without a context still decrypt", () => {
  const key = randomBytes(32).toString("base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  const ct = Buffer.concat([cipher.update("old token", "utf8"), cipher.final()]);
  const legacy = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ct]);
  assert.ok(isLegacy(legacy));
  assert.equal(open(legacy, key, contexts.githubAccess(9)), "old token");
  assert.ok(!isLegacy(seal("new", key, "x")));
});

test("async sessions never persist raw cookies and reject expired or blocked users", async () => {
  const client = createClient({ url: "file::memory:" });
  try {
    await migrateHosted(client);
    await client.execute(`INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
      VALUES (1, 123, 'test-user', X'00', 'codespace', '2026-01-01', '2026-01-01')`);
    const session = await insertSession(client, 1);
    const stored = (await client.execute("SELECT id, expires_at FROM sessions")).rows[0];
    assert.notEqual(stored.id, session.value);
    assert.equal(stored.id, createHash("sha256").update(session.value).digest("base64url"));
    assert.ok(Date.parse(String(stored.expires_at)) > Date.now() + 29 * 24 * 60 * 60_000);
    assert.equal((await readSession(client, session.value))?.userId, 1);
    assert.equal(await readSession(client, randomBytes(32).toString("base64url")), null);
    assert.equal(await readSession(client, "malformed"), null);
    await client.execute("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'");
    assert.equal(await readSession(client, session.value), null);
    assert.equal(Number((await client.execute("SELECT count(*) AS n FROM sessions")).rows[0].n), 0);
    const blocked = await insertSession(client, 1);
    await client.execute("UPDATE users SET blocked = 1 WHERE id = 1");
    assert.equal(await readSession(client, blocked.value), null);
    await client.execute("UPDATE users SET blocked = 0 WHERE id = 1");
    const logout = await insertSession(client, 1);
    await deleteSession(client, logout.value);
    assert.equal(await readSession(client, logout.value), null);
  } finally {
    client.close();
  }
});
