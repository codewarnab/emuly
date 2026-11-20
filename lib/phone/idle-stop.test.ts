import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
import { ANDROID_UNKNOWN_GRACE_MS, IDLE_WARNING_MS, idleStopAt, stopIdlePhones } from "./idle-stop.ts";
import type { OutgoingEvent } from "../data/events.ts";
import { createActivity, androidIdleMs, ACTIVITY_WRITE_MS } from "./last-activity.ts";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

async function fixture(lastActivity: string | null, idleMin = 30, androidState = "ready", started: string | null = null) {
  const client = createClient({ url: "file::memory:" });
  await migrateHosted(client);
  await client.executeMultiple(`
    INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
      VALUES (1, 11, 'synthetic-user', X'00', 'codespace', '2026-01-01', '2026-01-01');
    INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, state, android_state, created_at, idle_timeout_min)
      VALUES ('p1', 1, 'space-1', 'fixture/template', 'fixture', 'running', '${androidState}', '2026-11-01', ${idleMin});`);
  if (started) await client.execute({ sql: "UPDATE phones SET last_started_at = ?", args: [started] });
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

test("when a ready phone's Android cannot be read, it gets a grace time and then stops", async () => {
  const inGrace = await fixture(ago(40));
  try { assert.deepEqual((await run(inGrace, null)).stops, []); }
  finally { inGrace.close(); }
  const pastGrace = await fixture(ago(30 + ANDROID_UNKNOWN_GRACE_MS / 60_000));
  try { assert.deepEqual((await run(pastGrace, null)).stops, ["p1"]); }
  finally { pastGrace.close(); }
});

test("a phone whose Android failed stops after its idle time from the codespace start, without asking Android", async () => {
  const client = await fixture(null, 30, "failed", ago(31));
  try {
    let asked = false;
    const stops: string[] = [];
    await stopIdlePhones({ database: client, clock: () => NOW, androidIdleMs: async () => { asked = true; return 0; },
      stop: async (_, id) => { stops.push(id); } });
    assert.deepEqual(stops, ["p1"]);
    assert.equal(asked, false);
  } finally { client.close(); }
});

test("a phone that is still booting is left to the boot code", async () => {
  const client = await fixture(null, 30, "booting", ago(90));
  try { assert.deepEqual((await run(client, null)).stops, []); }
  finally { client.close(); }
});

test("a phone with no recorded time at all keeps running", async () => {
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
  // Android 16 (API 36) adds a suffix; measured on a phone 2026-11-20.
  assert.equal(androidIdleMs("2383.86 4300.95\n mLastUserActivityTime(excludingAttention)=43582\n"), 2_340_278);
  assert.equal(androidIdleMs("no dump here"), null);
});

async function warnRun(client: ReturnType<typeof createClient>, android: number | null, now = NOW) {
  const events: OutgoingEvent[] = []; const stops: string[] = [];
  await stopIdlePhones({ database: client, clock: () => now, androidIdleMs: async () => android,
    stop: async (_, id) => { stops.push(id); }, emit: event => { events.push(event); } });
  return { events, stops };
}

test("5 min before the idle stop, the phone gets one phone.idle_warning with the stop time", async () => {
  const client = await fixture(ago(27));
  try {
    const first = await warnRun(client, 27 * 60_000);
    assert.deepEqual(first.stops, []);
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0]!.type, "phone.idle_warning");
    assert.equal(first.events[0]!.data.idle_stop_at, new Date(NOW + 3 * 60_000).toISOString());
    // The next minute: the same idle period, so no second warning. Small Android read jitter is not use.
    assert.equal((await warnRun(client, 28 * 60_000 - 2_000, NOW + 60_000)).events.length, 0);
    // After the stop time the phone stops.
    assert.deepEqual((await warnRun(client, 31 * 60_000, NOW + 4 * 60_000)).stops, ["p1"]);
  } finally { client.close(); }
});

test("use after a warning starts a new idle period, which gets its own warning", async () => {
  const client = await fixture(ago(26));
  try {
    assert.equal((await warnRun(client, 26 * 60_000)).events.length, 1);
    await client.execute({ sql: "UPDATE phones SET last_activity_at = ?", args: [ago(0)] });
    assert.equal((await warnRun(client, 26 * 60_000, NOW + 26 * 60_000)).events.length, 1);
  } finally { client.close(); }
});

test("a phone not yet in the warning window gets no warning and Android is not asked", async () => {
  const client = await fixture(new Date(NOW - (30 * 60_000 - IDLE_WARNING_MS) + 1_000).toISOString());
  try {
    let asked = false;
    const events: OutgoingEvent[] = [];
    await stopIdlePhones({ database: client, clock: () => NOW, androidIdleMs: async () => { asked = true; return null; },
      stop: async () => {}, emit: event => { events.push(event); } });
    assert.equal(asked, false);
    assert.equal(events.length, 0);
  } finally { client.close(); }
});

test("idleStopAt gives the stop time only for a running, not booting, not kept phone", () => {
  const base = { state: "running", android_state: "ready", idle_timeout_min: 30, last_activity_at: ago(10), keeping: 0 };
  assert.equal(idleStopAt(base), new Date(NOW + 20 * 60_000).toISOString());
  assert.equal(idleStopAt({ ...base, last_activity_at: null, android_started_at: ago(5) }), new Date(NOW + 25 * 60_000).toISOString());
  assert.equal(idleStopAt({ ...base, keeping: 1 }), null);
  assert.equal(idleStopAt({ ...base, state: "stopped" }), null);
  assert.equal(idleStopAt({ ...base, android_state: "booting" }), null);
});
