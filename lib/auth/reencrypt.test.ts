import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
import { contexts, open, openWithKey, seal } from "./crypto-core.ts";
import { reencryptAll } from "./reencrypt.ts";

const newKey = () => randomBytes(32).toString("base64");

function legacySeal(plain: string, key: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ct]);
}

test("open tries the current key first, then the old key", () => {
  const [current, old] = [newKey(), newKey()];
  const box = seal("secret", old, "ctx");
  assert.deepEqual(openWithKey(box, [current, old], "ctx"), { plain: "secret", keyIndex: 1 });
  assert.equal(openWithKey(seal("secret", current, "ctx"), [current, old], "ctx").keyIndex, 0);
  assert.throws(() => open(box, [current], "ctx"));
});

test("rotation re-encrypts old-key and legacy values with the new key only", async () => {
  const client = createClient({ url: "file::memory:" });
  try {
    await migrateHosted(client);
    const [current, old] = [newKey(), newKey()];
    await client.execute({ sql: `INSERT INTO users (id, github_id, login, token_cipher, refresh_cipher, token_scopes, created_at, last_seen_at)
      VALUES (1, 77, 'synthetic', ?, ?, '', '2026-01-01', '2026-01-01')`,
      args: [seal("access", old, contexts.githubAccess(77)), legacySeal("refresh", old)] });
    await client.execute({ sql: `INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
      VALUES (2, 78, 'fresh', ?, '', '2026-01-01', '2026-01-01')`, args: [seal("current", current, contexts.githubAccess(78))] });

    const first = await reencryptAll(client, [current, old]);
    assert.deepEqual(first, { checked: 3, updated: 2, failed: [] });

    const rows = (await client.execute("SELECT id, token_cipher, refresh_cipher FROM users ORDER BY id")).rows;
    const box = (value: unknown) => new Uint8Array(value as ArrayBuffer);
    assert.equal(open(box(rows[0]!.token_cipher), [current], contexts.githubAccess(77)), "access");
    assert.equal(open(box(rows[0]!.refresh_cipher), [current], contexts.githubRefresh(77)), "refresh");
    assert.equal(box(rows[0]!.refresh_cipher)[0], 2);
    assert.equal(open(box(rows[1]!.token_cipher), [current], contexts.githubAccess(78)), "current");

    assert.deepEqual(await reencryptAll(client, [current]), { checked: 3, updated: 0, failed: [] });
    const unknown = await reencryptAll(client, [newKey()]);
    assert.equal(unknown.failed.length, 3);
  } finally {
    client.close();
  }
});
