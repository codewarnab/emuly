import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "./async-database.ts";
import { migrateHosted } from "./hosted-migrations.ts";
import { purgeDeletedPhones } from "./purge-deleted-phones.ts";

const NOW = Date.parse("2026-12-03T12:00:00Z");

test("deleted phones and their rows go once their hours leave the billing month", async () => {
  const client = createClient({ url: "file::memory:" });
  try {
    await migrateHosted(client);
    await client.execute("PRAGMA foreign_keys = OFF"); // Prove the purge does not rely on the cascade.
    await client.executeMultiple(`
      INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
        VALUES (1, 11, 'synthetic-user', X'00', 'codespace', '2026-01-01', '2026-01-01');
      INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, state, created_at) VALUES
        ('old-deleted', 1, 'space-old', 'fixture/template', 'fixture', 'deleted', '2026-11-01'),
        ('new-deleted', 1, 'space-new', 'fixture/template', 'fixture', 'deleted', '2026-11-01'),
        ('kept', 1, 'space-kept', 'fixture/template', 'fixture', 'stopped', '2026-11-01');
      INSERT INTO runs (phone_id, cores, started_at, stopped_at, source) VALUES
        ('old-deleted', 2, '2026-11-20T00:00:00Z', '2026-11-20T01:00:00Z', 'emuly'),
        ('new-deleted', 2, '2026-12-02T00:00:00Z', '2026-12-02T01:00:00Z', 'emuly'),
        ('kept', 2, '2026-10-01T00:00:00Z', '2026-10-01T01:00:00Z', 'emuly');
      INSERT INTO events (phone_id, user_id, ts, kind, message) VALUES
        ('old-deleted', 1, '2026-11-20', 'step', 'delete accepted'), ('kept', 1, '2026-11-20', 'step', 'stopped');
      INSERT INTO diagnostic_operations (id, owner_id, phone_id, run_id, kind, started_at, release, observer_id)
        VALUES ('op-1', 1, 'old-deleted', 'run-1', 'delete', '2026-11-20', 'test', 'observer');
      INSERT INTO diagnostic_steps (operation_id, step_id, producer, producer_run_id, sequence, code, attempt, outcome, observed_at, record)
        VALUES ('op-1', 'step-1', 'app', 'run-1', 1, 'github_delete', 1, 'succeeded', '2026-11-20', '{}');`);

    assert.equal(await purgeDeletedPhones(client, () => NOW), 1);

    const ids = (await client.execute("SELECT id FROM phones ORDER BY id")).rows.map(row => row.id);
    assert.deepEqual(ids, ["kept", "new-deleted"]);
    const left = async (sql: string) => Number((await client.execute(sql)).rows[0]!.n);
    assert.equal(await left("SELECT count(*) AS n FROM runs WHERE phone_id = 'old-deleted'"), 0);
    assert.equal(await left("SELECT count(*) AS n FROM events WHERE phone_id = 'old-deleted'"), 0);
    assert.equal(await left("SELECT count(*) AS n FROM diagnostic_steps"), 0);
    assert.equal(await left("SELECT count(*) AS n FROM events WHERE phone_id = 'kept'"), 1);
    assert.equal(await left("SELECT count(*) AS n FROM runs WHERE phone_id = 'new-deleted'"), 1);
  } finally { client.close(); }
});
