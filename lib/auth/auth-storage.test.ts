import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { seal, open } from "./crypto-core.ts";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
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
