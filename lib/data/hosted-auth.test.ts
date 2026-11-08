import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createClient, transaction } from "./async-database.ts";
import { migrateHosted } from "./hosted-migrations.ts";
import { MIGRATIONS } from "./migrations.ts";
import { userSettings, updateSettings } from "./settings.ts";
import { readUsage } from "./usage.ts";
import { insertSession, readSession, deleteSession } from "../auth/session-store.ts";
import { createDiagnostics } from "../diagnostics/diagnostics.ts";
import { createWebhookService } from "../webhooks/webhooks.ts";
import { createWebhookOutbox } from "../webhooks/webhook-outbox.ts";
import { seal, open } from "../auth/crypto-core.ts";
import { randomBytes } from "node:crypto";

// This contract covers the actual async auth functions and migration runner together.
// The older auth-storage test owns interoperability with existing native SQLite data.
for (const hosted of [false, true]) {
  test(`async database contracts (${hosted ? "hosted Turso" : "local libSQL"})`, {
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
      await client.execute(`INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
        VALUES (2, 2, 'other', X'00', '', '2026-01-01', '2026-01-01')`);
      if (!hosted) {
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const writing = transaction(client, async queries => {
          await queries.execute("UPDATE users SET login = 'rolled-back' WHERE id = 2");
          entered();
          await gate;
          throw new Error("synthetic rollback");
        });
        const failed = assert.rejects(writing, /synthetic rollback/);
        await started;
        const independent = client.execute("UPDATE users SET login = 'independent' WHERE id = 2");
        release();
        await failed;
        await independent;
        assert.equal((await client.execute("SELECT login FROM users WHERE id = 2")).rows[0].login, "independent");
      }
      const otherSettings = await userSettings(client, 2);
      await updateSettings(client, 1, { default_idle_min: 45 });
      const savedSettings = await userSettings(client, 1);
      // Reject the second write, after user_settings has already changed.
      await client.execute(`CREATE TRIGGER reject_allowance BEFORE INSERT ON billing_settings
        BEGIN SELECT RAISE(ABORT, 'synthetic billing failure'); END`);
      try {
        await assert.rejects(updateSettings(client, 1, { allowance_core_hours: 50, default_idle_min: 60 }));
        assert.deepEqual(await userSettings(client, 1), savedSettings);
        assert.equal(Number((await client.execute("SELECT allowance_core_hours FROM user_settings WHERE user_id = 1")).rows[0].allowance_core_hours), 120);
      } finally { await client.execute("DROP TRIGGER reject_allowance"); }
      await updateSettings(client, 1, { allowance_core_hours: 50, auto_keep: true });
      assert.equal((await userSettings(client, 1)).default_idle_min, 45);
      assert.deepEqual(await userSettings(client, 2), otherSettings);
      await client.execute(`INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, state, created_at, runner_secret)
        VALUES ('synthetic-phone', 1, 'synthetic-space', 'fixture/template', 'fixture', 'running', '2026-11-01', X'00')`);
      const key = randomBytes(32).toString("base64");
      const baseUrl = "https://phonelink.example";
      const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
      let sends = 0;
      const deliver = createWebhookOutbox({ database: client, baseUrl, resolve,
        decrypt: box => open(box, key), send: async () => { sends++; return 204; } });
      const hooks = createWebhookService({ database: client, baseUrl, resolve, deliver, encrypt: value => seal(value, key) });
      const hook = await hooks.create(1, { url: "https://receiver.example", events: ["phone.ready"] });
      await hooks.emit({ userId: 1, type: "phone.ready", createdAt: new Date().toISOString(), data: { message: "token=private" } });
      assert.equal((await hooks.deliveries(1, hook.id)).length, 1);
      assert.doesNotMatch(String((await client.execute("SELECT body FROM webhook_deliveries")).rows[0].body), /private/);
      await deliver();
      assert.equal(sends, 1);
      assert.equal((await hooks.deliveries(1, hook.id))[0].status, 204);
      const competing = await Promise.allSettled([hooks.test(1, hook.id), hooks.test(1, hook.id)]);
      assert.equal(competing.filter(result => result.status === "fulfilled").length, 1);
      await assert.rejects(hooks.remove(2, hook.id), /not found/);
      await hooks.remove(1, hook.id);

      const previousDiagnostics = process.env.PHONELINK_DIAGNOSTICS;
      process.env.PHONELINK_DIAGNOSTICS = "1";
      try {
        const diagnostics = createDiagnostics(client);
        const operation = await diagnostics.operation(1, "synthetic-phone", "create");
        assert.ok(operation);
        const ts = new Date().toISOString();
        const record = { stepId: "a".repeat(32), producer: "setup", producerRunId: "b".repeat(32), sequence: 1,
          code: "sdk_packages", attempt: 1, startedAt: ts, finishedAt: ts, durationMs: 17,
          outcome: "succeeded", errorCode: "none", quality: "exact" };
        await client.execute(`CREATE TRIGGER reject_cursor BEFORE INSERT ON diagnostic_cursors
          BEGIN SELECT RAISE(ABORT, 'synthetic cursor failure'); END`);
        await diagnostics.collect(operation, { records: [record], cursor: 200, dropped: 0 });
        assert.equal(Number((await client.execute("SELECT count(*) AS n FROM diagnostic_steps")).rows[0].n), 0);
        assert.equal(Number((await client.execute("SELECT count(*) AS n FROM diagnostic_daily")).rows[0].n), 0);
        assert.equal(await diagnostics.cursor(operation), 0);
        await client.execute("DROP TRIGGER reject_cursor");
        await Promise.all([diagnostics.collect(operation, { records: [record], cursor: 200, dropped: 0 }),
          diagnostics.collect(operation, { records: [record], cursor: 200, dropped: 0 })]);
        assert.equal(await diagnostics.cursor(operation), 200);
        assert.equal(Number((await client.execute("SELECT sum(samples) AS n FROM diagnostic_daily")).rows[0].n), 1);
      } finally {
        if (previousDiagnostics === undefined) delete process.env.PHONELINK_DIAGNOSTICS;
        else process.env.PHONELINK_DIAGNOSTICS = previousDiagnostics;
      }
      await client.execute(`INSERT INTO runs (phone_id, cores, started_at, source) VALUES ('synthetic-phone', 4, '2026-11-01T00:00:00.000Z', 'synthetic')`);
      const clock = () => Date.parse("2026-11-01T02:00:00.000Z");
      assert.equal((await readUsage(client, 1, clock)).used_core_hours, 8);
      assert.equal((await readUsage(client, 1, clock)).allowance_core_hours, 50);
      assert.equal((await readUsage(client, 2, clock)).used_core_hours, 0);
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
      throw new Error("Async database integration failed; provider details suppressed");
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
