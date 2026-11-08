import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createClient, transaction } from "./async-database.ts";
import { migrateHosted } from "./hosted-migrations.ts";
import { MIGRATIONS } from "./migrations.ts";
import { insertSession, readSession, deleteSession } from "../auth/session-store.ts";

// This contract covers the actual async auth functions and migration runner together.
// The older auth-storage test owns interoperability with existing native SQLite data.
for (const hosted of [false, true]) {
  test(`async auth and deployment migrations (${hosted ? "hosted Turso" : "local libSQL"})`, {
    skip: hosted && !process.env.PHONELINK_TEST_DATABASE_URL_FILE,
  }, async () => {
    const url = hosted ? (await readFile(process.env.PHONELINK_TEST_DATABASE_URL_FILE!, "utf8")).trim() : "file::memory:";
    const authToken = hosted ? (await readFile(process.env.PHONELINK_TEST_DATABASE_TOKEN_FILE!, "utf8")).trim() : undefined;
    const client = createClient({ url, authToken });
    let ownsSchema = false;
    try {
      assert.equal((await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).rows.length, 0,
        "Refusing a nonempty test database");
      ownsSchema = true;
      await migrateHosted(client);
      await client.execute(`INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
        VALUES (1, 1, 'synthetic', X'00', '', '2026-01-01', '2026-01-01')`);
      const original = await insertSession(client, 1);
      await migrateHosted(client);
      assert.equal(Number((await client.execute("SELECT count(*) AS n FROM schema_migrations")).rows[0].n), MIGRATIONS.length);
      assert.equal((await readSession(client, original.value))?.userId, 1);
      const stored = (await client.execute("SELECT id FROM sessions")).rows[0].id;
      assert.notEqual(stored, original.value);
      assert.equal(await readSession(client, "malformed"), null);

      // If rotation cannot insert its replacement, the old session must survive.
      await assert.rejects(transaction(client, async queries => {
        await deleteSession(queries, original.value);
        await insertSession(queries, 999);
      }));
      assert.equal((await readSession(client, original.value))?.userId, 1);
      const replacement = await transaction(client, async queries => {
        await deleteSession(queries, original.value);
        return insertSession(queries, 1);
      });
      assert.equal(await readSession(client, original.value), null);
      assert.equal((await readSession(client, replacement.value))?.userId, 1);
      await deleteSession(client, replacement.value);
      assert.equal(await readSession(client, replacement.value), null);

      const expired = await insertSession(client, 1);
      await client.execute("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'");
      assert.equal(await readSession(client, expired.value), null);
      const blocked = await insertSession(client, 1);
      await client.execute("UPDATE users SET blocked = 1 WHERE id = 1");
      assert.equal(await readSession(client, blocked.value), null);
      assert.equal(Number((await client.execute("SELECT count(*) AS n FROM sessions")).rows[0].n), 0);
    } catch (error) {
      // Provider exceptions can contain connection details; do not print them.
      if (error instanceof assert.AssertionError) throw error;
      throw new Error("Async auth/migration integration failed; provider details suppressed");
    } finally {
      try {
        if (ownsSchema) {
          const names = MIGRATIONS.flatMap(sql => [...sql.matchAll(/CREATE TABLE (\w+)/g)].map(match => match[1]));
          await client.batch([...names.reverse().map(name => `DROP TABLE IF EXISTS "${name}"`), "DROP TABLE IF EXISTS schema_migrations"], "write");
        }
      } finally { client.close(); }
    }
  });
}
