import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
import { withLease } from "../data/coordination.ts";
import { createRunnerUpdater, runnerCurrent, runnerIdle, RUNNER_UPDATE, type RunnerHealth, type UpdatePhone } from "./runner-update.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const OLD = new Date(NOW - 10 * 60_000).toISOString();
const quietBusy = { viewers: 0, links: 0, work: 0, idle_ms: 60_000 };

test("version match: the same version and scripts hash is current; anything else is old", () => {
  assert.equal(runnerCurrent({ ok: true, version: 17, scripts: "abc" }, 17, "abc"), true);
  assert.equal(runnerCurrent({ ok: true, version: 16, scripts: "abc" }, 17, "abc"), false);
  assert.equal(runnerCurrent({ ok: true, version: 17, scripts: "old" }, 17, "abc"), false);
  assert.equal(runnerCurrent(null, 17, "abc"), false);
});

test("safe time on the runner: no viewer, no link, no work, and no request in the last 30 s", () => {
  assert.equal(runnerIdle({ busy: quietBusy }), true);
  assert.equal(runnerIdle({ busy: { ...quietBusy, viewers: 1 } }), false, "a stream viewer or a recording");
  assert.equal(runnerIdle({ busy: { ...quietBusy, links: 1 } }), false);
  assert.equal(runnerIdle({ busy: { ...quietBusy, work: 1 } }), false, "an adb, apps or agent call in progress");
  assert.equal(runnerIdle({ busy: { ...quietBusy, idle_ms: RUNNER_UPDATE.runnerQuietMs - 1 } }), false);
  assert.equal(runnerIdle({}), true, "a v16 runner has no busy field; the server-side quiet time decides");
});

async function database(phones: [string, string, string | null][]) {
  const client = createClient({ url: ":memory:" });
  await migrateHosted(client);
  await client.execute("INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at) VALUES (1, 11, 'a', X'00', 'codespace', '2026-01-01', '2026-01-01')");
  for (const [id, state, android] of phones) await client.execute({ sql: `INSERT INTO phones (id, user_id, codespace_name, repo_full_name,
    machine, state, android_state, created_at, idle_timeout_min, last_activity_at) VALUES (?, 1, ?, 'r/t', 'm', ?, ?, '2026-11-01', 30, ?)`,
  args: [id, `space-${id}`, state, android, OLD] });
  return client;
}

/** A fake codespace: the runner reports `version` until install runs, then the new version. */
function harness(client: ReturnType<typeof createClient>, { start = 16, busy = quietBusy as RunnerHealth["busy"], android = 10 * 60_000 as number | null,
  installState = "ready", answers = true } = {}) {
  let now = NOW;
  const versions = new Map<string, number>();
  const installs: string[] = [];
  const updater = createRunnerUpdater({
    database: client, version: 17, scripts: () => "hash", clock: () => now, pause: async ms => { now += ms; }, log: () => {},
    health: async (phone: UpdatePhone) => ({ ok: true, version: versions.get(phone.id) ?? start, scripts: "hash", busy }),
    androidIdleMs: async () => android,
    install: async phone => { installs.push(phone.id); if (answers) versions.set(phone.id, 17); return { state: installState }; },
    withUserLease: (userId, work) => withLease(client, `phones:${userId}`, work),
  });
  return { updater, installs, advance: (ms: number) => { now += ms; }, versions };
}

test("a quiet running phone with an old runner is updated in place and confirmed by /health", async () => {
  const client = await database([["p1", "running", "ready"]]);
  const { updater, installs } = harness(client);
  assert.deepEqual([...await updater.pass()], [["p1", "updated"]]);
  assert.deepEqual(installs, ["p1"]);
  // The phone stays running and ready: only the runner restarted.
  const row = (await client.execute("SELECT state, android_state FROM phones WHERE id = 'p1'")).rows[0]!;
  assert.deepEqual([row.state, row.android_state], ["running", "ready"]);
  assert.deepEqual([...await updater.pass()], [["p1", "current"]], "the next pass sees the new runner");
  client.close();
});

test("an old deploy never installs its older runner over a newer one, and the version is recorded", async () => {
  // 26 Nov 2026: a VM scheduler with runner 18 in its code replaced runner 25 with 18.
  const client = await database([["p1", "running", "ready"]]);
  const { updater, installs } = harness(client, { start: 25 });
  assert.deepEqual([...await updater.pass()], [["p1", "newer"]]);
  assert.deepEqual(installs, []);
  assert.equal((await client.execute("SELECT runner_version FROM phones WHERE id = 'p1'")).rows[0]!.runner_version, 25);
  client.close();
});

test("an update records the new runner version", async () => {
  const client = await database([["p1", "running", "ready"]]);
  const { updater } = harness(client);
  await updater.pass();
  assert.equal((await client.execute("SELECT runner_version FROM phones WHERE id = 'p1'")).rows[0]!.runner_version, 17);
  client.close();
});

test("no update during a boot or a stop, or while Android is not ready", async () => {
  const client = await database([["boot", "booting", "idle"], ["stop", "stopping", "ready"], ["android", "running", "booting"], ["off", "stopped", "idle"]]);
  const { updater, installs } = harness(client);
  assert.equal((await updater.pass()).size, 0);
  assert.deepEqual(installs, []);
  client.close();
});

test("no update while the user's start or stop holds the phone lease", async () => {
  const client = await database([["p1", "running", "ready"]]);
  const { updater, installs } = harness(client);
  let results;
  await withLease(client, "phones:1", async () => { results = await updater.pass(); });
  assert.deepEqual([...results!], [["p1", "busy"]]);
  assert.deepEqual(installs, []);
  client.close();
});

test("no update while someone uses the phone: recent agent or browser use, Android input, or a stream viewer", async () => {
  const recent = await database([["p1", "running", "ready"]]);
  await recent.execute({ sql: "UPDATE phones SET last_activity_at = ?", args: [new Date(NOW - 60_000).toISOString()] });
  assert.deepEqual([...await harness(recent).updater.pass()], [["p1", "busy"]]);
  recent.close();
  const touch = await database([["p1", "running", "ready"]]);
  assert.deepEqual([...await harness(touch, { android: 30_000 }).updater.pass()], [["p1", "busy"]]);
  touch.close();
  const viewer = await database([["p1", "running", "ready"]]);
  const watched = harness(viewer, { busy: { ...quietBusy, viewers: 1 } });
  assert.deepEqual([...await watched.updater.pass()], [["p1", "busy"]]);
  assert.deepEqual(watched.installs, []);
  viewer.close();
});

test("a failed update waits 5 min, then 15 min, then retries and succeeds", async () => {
  const client = await database([["p1", "running", "ready"]]);
  const fake = harness(client, { answers: false });
  assert.deepEqual([...await fake.updater.pass()], [["p1", "failed"]], "the new runner never answers within 90 s");
  fake.advance(60_000);
  assert.deepEqual([...await fake.updater.pass()], [["p1", "waiting"]]);
  fake.advance(RUNNER_UPDATE.backoffMs[0]);
  assert.deepEqual([...await fake.updater.pass()], [["p1", "failed"]]);
  fake.advance(RUNNER_UPDATE.backoffMs[0]);
  assert.deepEqual([...await fake.updater.pass()], [["p1", "waiting"]], "the second wait is 15 min");
  fake.advance(RUNNER_UPDATE.backoffMs[1]);
  fake.versions.set("p1", 17);
  assert.deepEqual([...await fake.updater.pass()], [["p1", "current"]]);
  assert.equal(fake.installs.length, 2);
  client.close();
});

test("at most 2 phones update at the same time", async () => {
  const client = await database([["a", "running", "ready"], ["b", "running", "ready"], ["c", "running", "ready"], ["d", "running", "ready"]]);
  await client.executeMultiple(`INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at) VALUES
    (2, 12, 'b', X'00', 'codespace', '2026-01-01', '2026-01-01'), (3, 13, 'c', X'00', 'codespace', '2026-01-01', '2026-01-01'),
    (4, 14, 'd', X'00', 'codespace', '2026-01-01', '2026-01-01');
    UPDATE phones SET user_id = 2 WHERE id = 'b'; UPDATE phones SET user_id = 3 WHERE id = 'c'; UPDATE phones SET user_id = 4 WHERE id = 'd';`);
  let active = 0; let peak = 0; const done = new Set<string>();
  const updater = createRunnerUpdater({ database: client, version: 17, scripts: () => "hash", clock: () => NOW, log: () => {},
    health: async phone => ({ ok: true, version: done.has(phone.id) ? 17 : 16, scripts: "hash" }),
    androidIdleMs: async () => null,
    install: async phone => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 20));
      active--; done.add(phone.id); return { state: "ready" }; },
    withUserLease: (userId, work) => withLease(client, `phones:${userId}`, work), pause: async () => {} });
  await updater.pass();
  assert.equal(peak, 2);
  client.close();
});
