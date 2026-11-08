// Run only in a disposable environment against an EMPTY disposable database.
// Install @libsql/client there with --ignore-scripts. Never run against production.
// Credentials are read from files, never passed as command arguments or logged.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client/web';

const [urlFile, tokenFile] = process.argv.slice(2);
assert(urlFile && tokenFile, 'Usage: node verify-turso.mjs <url-file> <token-file>');
const url = (await readFile(urlFile, 'utf8')).trim();
const authToken = (await readFile(tokenFile, 'utf8')).trim();
assert(/^(libsql|https):\/\//.test(url), 'A remote database URL is required');
const clients = [createClient({ url, authToken }), createClient({ url, authToken })];
const db = clients[0];
const source = await readFile(new URL('../lib/data/migrations.ts', import.meta.url), 'utf8');
// Read SQL as data; do not import or execute the application module.
const block = source.split('const MIGRATIONS = [')[1]?.split('\n];')[0];
assert(block, 'Migration array not found');
const migrations = [...block.matchAll(/`([^`]+)`/g)].map(match => match[1]);
assert.equal(migrations.length, 9, 'Review the probe when migrations change');
// Current migration SQL has no semicolons in quoted values. Fail closed on drift.
assert(!migrations.some(sql => /'[^'\n]*;[^'\n]*'/.test(sql)), 'Use a SQL parser for semicolons in literals');
const expectedTables = migrations.flatMap(sql => [...sql.matchAll(/CREATE TABLE (\w+)/g)].map(match => match[1]));
assert.equal(expectedTables.length, 23);
let ownsSchema = false;
let cleanupSucceeded = false;
const passed = [];
const check = async (name, fn) => { console.log(`Checking: ${name}`); await fn(); passed.push(name); console.log(`PASS: ${name}`); };
const count = async sql => Number((await db.execute(sql)).rows[0].n);

try {
  const existing = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  assert.equal(existing.rows.length, 0, 'Refusing a nonempty database');
  // Dedicated test database only; no other writer may use it during this run.
  ownsSchema = true;
  await check('all migration SQL with hosted migration tracking', async () => {
    await db.execute('CREATE TABLE probe_migrations (version INTEGER PRIMARY KEY)');
    for (const [index, migration] of migrations.entries()) {
      await db.batch([...migration.replace(/--[^\r\n]*/g, '').split(';').map(sql => sql.trim()).filter(Boolean), `INSERT INTO probe_migrations VALUES (${index + 1})`], 'write');
    }
    assert.equal(await count('SELECT count(*) AS n FROM probe_migrations'), 9);
    const tables = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'probe_migrations'");
    assert.deepEqual(tables.rows.map(row => row.name).sort(), [...expectedTables].sort());
  });
  const cipher = new Uint8Array([0, 1, 127, 128, 254, 255]);
  await check('generated user ID and binary ciphertext round trip', async () => {
    const result = await db.execute({ sql: `INSERT INTO users
      (github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
      VALUES (1, 'synthetic', ?, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z') RETURNING id`, args: [cipher] });
    assert.equal(Number(result.rows[0].id), 1);
    const stored = (await db.execute('SELECT token_cipher FROM users WHERE id = 1')).rows[0].token_cipher;
    assert.deepEqual(new Uint8Array(stored), cipher);
  });
  await check('foreign-key rejection', async () => {
    await assert.rejects(db.execute("INSERT INTO sessions VALUES ('invalid', 999, 'now', 'later')"),
      error => /FOREIGN KEY/i.test(error.code ?? '') || /FOREIGN KEY/i.test(error.message));
    assert.equal(await count('SELECT count(*) AS n FROM sessions'), 0);
  });
  await check('interactive rollback and committed dependent reads', async () => {
    for (const commit of [false, true]) {
      const tx = await db.transaction('write');
      try {
        await tx.execute("INSERT INTO notices VALUES (1, 'probe', 'month')");
        assert.equal(Number((await tx.execute("SELECT count(*) AS n FROM notices WHERE kind = 'probe'")).rows[0].n), 1);
        if (commit) await tx.commit(); else await tx.rollback();
      } finally { tx.close(); }
      assert.equal(await count("SELECT count(*) AS n FROM notices WHERE kind = 'probe'"), Number(commit));
    }
  });
  await check('batch failure rolls back earlier writes', async () => {
    await assert.rejects(db.batch([
      "INSERT INTO notices VALUES (1, 'rollback', 'month')",
      "INSERT INTO sessions VALUES ('invalid', 999, 'now', 'later')",
    ], 'write'), error => /FOREIGN KEY/i.test(`${error.code} ${error.message}`));
    assert.equal(await count("SELECT count(*) AS n FROM notices WHERE kind = 'rollback'"), 0);
  });
  await check('two independent clients: exactly one notice reservation', async () => {
    const results = await Promise.all(clients.map(client => client.execute(
      "INSERT OR IGNORE INTO notices VALUES (1, 'concurrent', 'month')")));
    assert.equal(results.reduce((sum, result) => sum + result.rowsAffected, 0), 1);
    assert.equal(await count("SELECT count(*) AS n FROM notices WHERE kind = 'concurrent'"), 1);
  });
  await check('targetless poller retry upsert', async () => {
    for (const value of [1, 2]) await db.execute({ sql: `INSERT INTO poller_retries VALUES (1, ?, 'probe')
      ON CONFLICT DO UPDATE SET retry_at = excluded.retry_at, error_code = excluded.error_code`, args: [value] });
    assert.equal(Number((await db.execute('SELECT retry_at FROM poller_retries')).rows[0].retry_at), 2);
  });
  await check('actual webhook fan-out SQL, randomblob, JSON, dates and rowid', async () => {
    await db.execute({ sql: `INSERT INTO webhooks (id,user_id,url,events,secret_cipher,created_at)
      VALUES ('probe',1,'https://example.invalid','["phone.created"]',?,'2026-01-01T00:00:00.000Z')`, args: [cipher] });
    const eventSource = await readFile(new URL('../lib/data/events.ts', import.meta.url), 'utf8');
    const sql = eventSource.match(/database\.prepare\(`(INSERT INTO webhook_deliveries[\s\S]*?)`\)/)?.[1];
    assert(sql, 'Event SQL not found; review probe');
    const timestamp = '2026-01-01T00:00:00.000Z';
    const result = await db.execute({ sql, args: ['event', 'phone.created', '{}', timestamp, timestamp, 1, null, null, null, 'phone.created'] });
    assert.equal(result.rowsAffected, 1);
    const row = (await db.execute("SELECT id FROM webhook_deliveries ORDER BY rowid DESC LIMIT 1")).rows[0];
    assert.match(row.id, /^dlv_[0-9a-f]{32}$/);
    assert.equal((await db.execute("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01T00:00:00.000Z', '+3 days') AS ts")).rows[0].ts, '2026-01-04T00:00:00.000Z');
    const claims = await Promise.all(clients.map(client => client.execute({ sql: `UPDATE webhook_deliveries SET next_try_at = '2026-01-02T00:00:00.000Z'
      WHERE id = ? AND state = 'pending' AND next_try_at <= '2026-01-01T00:00:00.000Z'`, args: [row.id] })));
    assert.equal(claims.reduce((sum, claim) => sum + claim.rowsAffected, 0), 1);
  });
  console.log(`Completed ${passed.length} compatibility checks. No application or region latency claim is implied.`);
} catch (error) {
  // Never print SDK errors, URLs, credentials, response bodies, or SQL-bound values.
  console.error(`FAILED after ${passed.length} checks. Next failing check requires investigation.`);
  console.error(`Error code: ${/^[A-Z0-9_]+$/.test(error.code) ? error.code : 'assertion-or-transport'}`);
  process.exitCode = 1;
} finally {
  if (ownsSchema) {
    try {
      // Reverse declaration order respects the current schema's dependencies.
      await db.batch([...expectedTables].reverse().map(name => `DROP TABLE IF EXISTS "${name}"`), 'write');
      await db.execute('DROP TABLE IF EXISTS probe_migrations');
      cleanupSucceeded = true;
    } catch { console.error('Cleanup incomplete. Delete the disposable database in Turso.'); process.exitCode = 1; }
  }
  for (const client of clients) client.close();
  if (cleanupSucceeded) console.log('Synthetic schema removed.');
}
