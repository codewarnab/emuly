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
import { createPhoneService } from "../phone/phone-mutations.ts";
import { createGitHubClient, GitHubError, type Codespace } from "../github/github.ts";
import { createStatePoller } from "../phone/poller.ts";
import { unreadAutoStops, acknowledgeAutoStops } from "../shared/hours.ts";
import { createAccessTokenProvider } from "../github/github-token.ts";
import { streamQuality, saveStreamQuality } from "../shared/display-settings.ts";
import { randomBytes } from "node:crypto";
import { issueSharedStreamTicket, takeSharedStreamTicket } from "../phone/shared-stream-ticket.ts";
import { importDatabase } from "./import-database.ts";

// This contract covers the actual async auth functions and migration runner together.
// The older auth-storage test owns interoperability with existing native SQLite data.
for (const hosted of [false, true]) {
  test(`async database contracts (${hosted ? "hosted Turso" : "local libSQL"})`, {
    skip: hosted && !process.env.EMULY_TEST_DATABASE_URL_FILE,
  }, async () => {
    const url = hosted ? (await readFile(process.env.EMULY_TEST_DATABASE_URL_FILE!, "utf8")).trim() : "file::memory:";
    const authToken = hosted ? (await readFile(process.env.EMULY_TEST_DATABASE_TOKEN_FILE!, "utf8")).trim() : undefined;
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
      const streamTicket = await issueSharedStreamTicket(client, { userId: 1, phoneId: "synthetic-phone", sessionId: "synthetic-session", origin: "https://fixture.example", cookie: "fixture-cookie" });
      assert.equal(await takeSharedStreamTicket(client, streamTicket, "synthetic-phone", "https://fixture.example", "wrong-cookie"), undefined);
      const redeemed = await Promise.all([0, 1].map(() => takeSharedStreamTicket(client, streamTicket, "synthetic-phone", "https://fixture.example", "fixture-cookie")));
      assert.equal(redeemed.filter(Boolean).length, 1, "a shared ticket can only be redeemed once");
      const key = randomBytes(32).toString("base64");
      const baseUrl = "https://emuly.example";
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

      const previousDiagnostics = process.env.EMULY_DIAGNOSTICS;
      process.env.EMULY_DIAGNOSTICS = "1";
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
        if (previousDiagnostics === undefined) delete process.env.EMULY_DIAGNOSTICS;
        else process.env.EMULY_DIAGNOSTICS = previousDiagnostics;
      }
      await client.execute(`INSERT INTO runs (phone_id, cores, started_at, source) VALUES ('synthetic-phone', 4, '2026-11-01T00:00:00.000Z', 'synthetic')`);
      const clock = () => Date.parse("2026-11-01T02:00:00.000Z");
      assert.equal((await readUsage(client, 1, clock)).used_core_hours, 8);
      assert.equal((await readUsage(client, 1, clock)).allowance_core_hours, 50);
      assert.equal((await readUsage(client, 2, clock)).used_core_hours, 0);
      // Exercise the production phone service and poller against the same hosted client.
      let created: Codespace | undefined;
      let creates = 0;
      let phoneClock = Date.parse("2026-11-08T00:00:00.000Z");
      const machine = { name: "standardLinux32gb", display_name: "4-core", cpus: 4, memory_in_bytes: 16 * 1024 ** 3 };
      const github = createGitHubClient({ database: client, accessToken: async () => "synthetic-token",
        fetch: async (url, init) => {
          if (String(url).endsWith("/machines")) return Response.json({ machines: [machine] });
          if (init?.method === "POST") {
            creates++;
            const body = JSON.parse(String(init.body));
            const intent = (await client.execute({ sql: "SELECT outcome FROM phone_creations WHERE phone_id = ?", args: [body.display_name] })).rows[0];
            assert.equal(intent.outcome, "unconfirmed", "intent commits before provider HTTP");
            created = { id: 567, name: "hosted-owned", display_name: body.display_name, state: "Starting", machine };
            throw new Error("synthetic lost response");
          }
          return Response.json({ codespaces: created ? [created] : [] });
        } });
      const phones = createPhoneService({ database: client, github, encrypt: value => seal(value, key), clock: () => phoneClock });
      await assert.rejects(phones.create(2, { repository: "fixture/template", repositoryId: 123, idleTimeoutMin: 30 }));
      await phones.sync(2);
      assert.equal(creates, 1, "reconciliation never resubmits an uncertain POST");
      const phoneId = created!.display_name!;
      assert.equal((await client.execute({ sql: "SELECT outcome FROM phone_creations WHERE phone_id = ?", args: [phoneId] })).rows[0].outcome, "confirmed");
      const phoneHook = await hooks.create(2, { url: "https://receiver.example", events: ["phone.stopped"] });
      const eventsBefore = Number((await client.execute({ sql: "SELECT count(*) AS n FROM events WHERE user_id = 2", args: [] })).rows[0].n);
      await client.execute("CREATE TRIGGER reject_phone_fanout BEFORE INSERT ON webhook_deliveries WHEN NEW.type = 'phone.stopped' BEGIN SELECT RAISE(ABORT, 'synthetic fanout failure'); END");
      created!.state = "Shutdown";
      phoneClock += 60_000;
      await assert.rejects(phones.sync(2));
      assert.equal((await client.execute({ sql: "SELECT state FROM phones WHERE id = ?", args: [phoneId] })).rows[0].state, "booting");
      assert.equal(Number((await client.execute("SELECT count(*) AS n FROM runs WHERE stopped_at IS NULL AND phone_id != 'synthetic-phone'")).rows[0].n), 1);
      assert.equal(Number((await client.execute("SELECT count(*) AS n FROM events WHERE user_id = 2")).rows[0].n), eventsBefore);
      await client.execute("DROP TRIGGER reject_phone_fanout");
      await phones.sync(2);
      await phones.sync(2);
      assert.equal((await hooks.deliveries(2, phoneHook.id)).length, 1);
      assert.equal(Number((await client.execute({ sql: "SELECT count(*) AS n FROM runs WHERE phone_id = ? AND stopped_at IS NULL", args: [phoneId] })).rows[0].n), 0);
      await hooks.remove(2, phoneHook.id);
      await client.execute({ sql: "INSERT INTO events (user_id, ts, kind, message) VALUES (2, ?, 'hours.auto_stopped', 'synthetic stop')", args: [new Date(phoneClock).toISOString()] });
      const notices = await unreadAutoStops(client, 2);
      await acknowledgeAutoStops(client, 1, notices.map(n => n.id));
      assert.equal((await unreadAutoStops(client, 2)).length, 1);
      await acknowledgeAutoStops(client, 2, notices.map(n => n.id));
      assert.equal((await unreadAutoStops(client, 2)).length, 0);
      let syncs = 0;
      const tick = createStatePoller({ database: client, clock: () => phoneClock, sync: async () => { syncs++; } });
      await tick();
      assert.ok(syncs >= 2, "poller reads and persists its state asynchronously");
      const limited = createStatePoller({ database: client, clock: () => phoneClock,
        sync: async userId => { if (userId === 2) throw new GitHubError("synthetic limit", 429); } });
      await limited();
      assert.equal((await client.execute("SELECT error_code FROM poller_retries WHERE user_id = 2")).rows[0].error_code, "rate_limited");
      const retried: number[] = [];
      const restarted = createStatePoller({ database: client, clock: () => phoneClock, sync: async userId => { retried.push(userId); } });
      await restarted();
      assert.ok(!retried.includes(2), "a fresh poller respects persisted backoff");
      phoneClock += 300_001;
      await restarted();
      assert.ok(retried.includes(2));
      assert.equal((await client.execute("SELECT user_id FROM poller_retries WHERE user_id = 2")).rows.length, 0);
      assert.equal(await streamQuality(client, 2), "auto");
      assert.equal((await saveStreamQuality(client, 2, "sharp")).ok, true);
      assert.equal((await saveStreamQuality(client, 2, "invalid")).ok, false);
      assert.equal(await streamQuality(client, 2), "sharp");
      assert.equal(await streamQuality(client, 1), "auto");
      const previousClientId = process.env.EMULY_GITHUB_CLIENT_ID;
      const previousClientSecret = process.env.EMULY_GITHUB_CLIENT_SECRET;
      process.env.EMULY_GITHUB_CLIENT_ID = "synthetic-client";
      process.env.EMULY_GITHUB_CLIENT_SECRET = "synthetic-secret";
      try {
        const now = Date.parse("2026-11-08T00:00:00.000Z");
        await client.execute({ sql: "UPDATE users SET token_cipher = ?, token_expires_at = ?, refresh_cipher = ?, refresh_expires_at = ? WHERE id = 2",
          args: [seal("synthetic-access", key), new Date(now).toISOString(), seal("synthetic-refresh", key), new Date(now + 86_400_000).toISOString()] });
        const accessToken = createAccessTokenProvider({ database: client, encrypt: value => seal(value, key), decrypt: value => open(value, key) });
        const secondInstance = createAccessTokenProvider({ database: client, encrypt: value => seal(value, key), decrypt: value => open(value, key) });
        let exchanges = 0;
        const options = { clock: () => now, fetch: async (_url: unknown, init?: RequestInit) => {
          exchanges++;
          assert.equal((init!.body as URLSearchParams).get("refresh_token"), "synthetic-refresh");
          return Response.json({ access_token: "synthetic-rotated", refresh_token: "synthetic-next-refresh", expires_in: 28_800,
            refresh_token_expires_in: 15_552_000, scope: "codespace", token_type: "bearer" });
        } };
        assert.deepEqual(await Promise.all([accessToken(2, options), secondInstance(2, options), accessToken(2, options)]),
          ["synthetic-rotated", "synthetic-rotated", "synthetic-rotated"]);
        assert.equal(exchanges, 1);
        const storedTokens = (await client.execute("SELECT token_cipher, refresh_cipher FROM users WHERE id = 2")).rows[0];
        assert.equal(open(storedTokens.token_cipher as unknown as Uint8Array, key), "synthetic-rotated");
        assert.equal(open(storedTokens.refresh_cipher as unknown as Uint8Array, key), "synthetic-next-refresh");
        assert.equal(await accessToken(2, options), "synthetic-rotated");
        assert.equal(exchanges, 1);
        await insertSession(client, 2);
        const otherSession = await insertSession(client, 1);
        await client.execute("UPDATE users SET token_expires_at = '2000-01-01' WHERE id = 2");
        await assert.rejects(accessToken(2, { clock: () => now, fetch: async () => Response.json({ error: "synthetic-private-error" }, { status: 400 }) }), /^Error: Sign in again$/);
        assert.equal((await client.execute("SELECT id FROM sessions WHERE user_id = 2")).rows.length, 0);
        assert.equal((await readSession(client, otherSession.value))?.userId, 1);
        await deleteSession(client, otherSession.value);
      } finally {
        if (previousClientId === undefined) delete process.env.EMULY_GITHUB_CLIENT_ID;
        else process.env.EMULY_GITHUB_CLIENT_ID = previousClientId;
        if (previousClientSecret === undefined) delete process.env.EMULY_GITHUB_CLIENT_SECRET;
        else process.env.EMULY_GITHUB_CLIENT_SECRET = previousClientSecret;
      }
      const original = await insertSession(client, 1);
      await migrateHosted(client);
      assert.equal(Number((await client.execute("SELECT count(*) AS n FROM schema_migrations")).rows[0].n), MIGRATIONS.length);
      assert.equal((await readSession(client, original.value))?.userId, 1);
      const imported = createClient({ url: "file::memory:" });
      try {
        await migrateHosted(imported);
        const counts = await importDatabase(client, imported);
        assert.equal(counts.users, 2);
        assert.equal((await readSession(imported, original.value))?.userId, 1);
        const sourceToken = (await client.execute("SELECT hex(token_cipher) AS cipher FROM users WHERE id = 2")).rows[0].cipher;
        assert.equal((await imported.execute("SELECT hex(token_cipher) AS cipher FROM users WHERE id = 2")).rows[0].cipher, sourceToken);
        await assert.rejects(importDatabase(client, imported), /empty/);
      } finally { imported.close(); }
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
      if (!hosted || error instanceof assert.AssertionError) throw error;
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
