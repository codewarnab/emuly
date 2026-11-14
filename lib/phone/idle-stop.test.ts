import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
import { stopIdlePhones } from "./idle-stop.ts";
import { createActivity, androidIdleMs, ACTIVITY_WRITE_MS } from "./last-activity.ts";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

async function fixture(lastActivity: string | null, idleMin = 30) {
  const client = createClient({ url: "file::memory:" });
  await migrateHosted(client);
  await client.executeMultiple(`
    INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
      VALUES (1, 11, 'synthetic-user', X'00', 'codespace', '2026-01-01', '2026-01-01');
    INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, state, android_state, created_at, idle_timeout_min)
      VALUES ('p1', 1, 'space-1', 'fixture/template', 'fixture', 'running', 'ready', '2026-11-01', ${idleMin});`);
  if (lastActivity) await client.execute({ sql: "UPDATE phones SET last_activity_at = ?", args: [lastActivity] });
  return client;
}

async function run(client: ReturnType<typeof createClient>, android: number | null) {
  const stops: string[] = [];
  const stopped = await stopIdlePhones({ database: client, clock: () => NOW,
    androidIdleMs: async () => android, stop: async (_, id) => { stops.push(id); } });
  return { stopped, stops };
}

test("a phone with a recent action keeps running and Android is not asked", async () => {
  const client = await fixture(ago(10));
  try {
    const stops: string[] = []; let asked = false;
    await stopIdlePhones({ database: client, clock: () => NOW, androidIdleMs: async () => { asked = true; return 0; },
      stop: async (_, id) => { stops.push(id); } });
    assert.deepEqual(stops, []);
    assert.equal(asked, false);
  } finally { client.close(); }
});

test("a phone with no action and no Android input for its idle time stops", async () => {
  const client = await fixture(ago(31));
  try { assert.deepEqual((await run(client, 40 * 60_000)).stops, ["p1"]); }
  finally { client.close(); }
});

test("a recent Android input (a scrcpy click) keeps the phone and moves the stored time up", async () => {
  const client = await fixture(ago(45));
  try {
    assert.deepEqual((await run(client, 5 * 60_000)).stops, []);
    const row = (await client.execute("SELECT last_activity_at FROM phones")).rows[0];
    assert.equal(row.last_activity_at, ago(5));
  } finally { client.close(); }
});

test("when Android cannot be read, the phone keeps running", async () => {
  const client = await fixture(ago(90));
  try { assert.deepEqual((await run(client, null)).stops, []); }
  finally { client.close(); }
});

test("a phone with no recorded action yet is left to GitHub's timer", async () => {
  const client = await fixture(null);
  try { assert.deepEqual((await run(client, 99 * 60_000)).stops, []); }
  finally { client.close(); }
});

test("activity writes at most once each 30 s for a phone, and recent() follows the idle time", async () => {
  const client = await fixture(ago(60), 30);
  try {
    let now = NOW;
    const activity = createActivity(client, () => now);
    const phone = { userId: 1, id: "p1" };
    assert.equal(await activity.recent(phone), false);
    activity.mark(phone);
    await new Promise(resolve => setTimeout(resolve, 20));
    const first = (await client.execute("SELECT last_activity_at FROM phones")).rows[0].last_activity_at;
    assert.equal(first, new Date(NOW).toISOString());
    now += ACTIVITY_WRITE_MS - 1;
    activity.mark(phone);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await client.execute("SELECT last_activity_at FROM phones")).rows[0].last_activity_at, first);
    now += 1;
    activity.mark(phone);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await client.execute("SELECT last_activity_at FROM phones")).rows[0].last_activity_at, new Date(now).toISOString());
    assert.equal(await activity.recent(phone), true);
  } finally { client.close(); }
});

test("androidIdleMs reads uptime and the last input time from the dump", () => {
  assert.equal(androidIdleMs("1234.50 900.00\n  mLastUserActivityTime=1200000 (34s ago)\n"), 34_500);
  assert.equal(androidIdleMs("no dump here"), null);
});
