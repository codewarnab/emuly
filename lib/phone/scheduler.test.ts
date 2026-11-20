import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
import { withLease, CoordinationBusyError } from "../data/coordination.ts";
import { createScheduler, dueUsers, eachLimited, syncIntervalFor, SYNC_TIERS, type SchedulerParts } from "./scheduler.ts";
import { schedulerHealth } from "./scheduler-health.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("sync tier: a phone that changes state syncs every 10 s, a running phone every 60 s, stopped phones every 30 min", () => {
  assert.equal(syncIntervalFor([{ state: "booting", android_state: null }, { state: "stopped", android_state: null }]), SYNC_TIERS.busyMs);
  assert.equal(syncIntervalFor([{ state: "stopping", android_state: null }]), SYNC_TIERS.busyMs);
  assert.equal(syncIntervalFor([{ state: "running", android_state: "booting" }]), SYNC_TIERS.busyMs);
  assert.equal(syncIntervalFor([{ state: "running", android_state: "idle" }]), SYNC_TIERS.busyMs);
  assert.equal(syncIntervalFor([{ state: "running", android_state: "ready" }, { state: "stopped", android_state: null }]), SYNC_TIERS.runningMs);
  assert.equal(syncIntervalFor([{ state: "running", android_state: "failed" }]), SYNC_TIERS.runningMs);
  assert.equal(syncIntervalFor([{ state: "stopped", android_state: null }]), SYNC_TIERS.stoppedMs);
  assert.ok(SYNC_TIERS.runningMs <= 60_000, "a running phone must sync at least as often as the old 60 s cron");
  assert.ok(SYNC_TIERS.busyMs <= 10_000, "a booting phone must sync at least every 10 s");
});

test("due users: only users past their tier interval, most urgent first; a user never synced is due", () => {
  const users = [
    { userId: 1, phones: [{ state: "stopped", android_state: null }], syncedAt: NOW - 10 * 60_000 },
    { userId: 2, phones: [{ state: "stopped", android_state: null }], syncedAt: NOW - 31 * 60_000 },
    { userId: 3, phones: [{ state: "running", android_state: "ready" }], syncedAt: NOW - 30_000 },
    { userId: 4, phones: [{ state: "running", android_state: "ready" }], syncedAt: NOW - 61_000 },
    { userId: 5, phones: [{ state: "booting", android_state: null }], syncedAt: NOW - 11_000 },
    { userId: 6, phones: [{ state: "booting", android_state: null }], syncedAt: NOW - 9_000 },
    { userId: 7, phones: [{ state: "stopped", android_state: null }], syncedAt: null },
  ];
  assert.deepEqual(dueUsers(users, NOW), [5, 4, 7, 2]);
});

test("eachLimited runs at most `limit` at a time and runs every item even after a failure", async () => {
  let active = 0; let peak = 0; const done: number[] = [];
  await eachLimited([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 4, async item => {
    active++; peak = Math.max(peak, active);
    await wait(5);
    active--;
    if (item === 3) throw new Error("one user fails");
    done.push(item);
  });
  assert.equal(peak, 4);
  assert.equal(done.length, 11);
});

async function database() {
  // A file database: two schedulers must share it as two hosts share Turso.
  const file = join(mkdtempSync(join(tmpdir(), "emuly-scheduler-")), "test.db");
  const client = createClient({ url: pathToFileURL(file).href });
  await migrateHosted(client);
  await client.executeMultiple(`
    INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
      VALUES (1, 11, 'a', X'00', 'codespace', '2026-01-01', '2026-01-01'), (2, 12, 'b', X'00', 'codespace', '2026-01-01', '2026-01-01'),
        (3, 13, 'c', X'00', 'codespace', '2026-01-01', '2026-01-01');
    INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, state, android_state, created_at, idle_timeout_min) VALUES
      ('p1', 1, 's1', 'r/t', 'm', 'booting', 'idle', '2026-11-01', 30),
      ('p2', 2, 's2', 'r/t', 'm', 'running', 'ready', '2026-11-01', 30),
      ('p3', 3, 's3', 'r/t', 'm', 'stopped', 'idle', '2026-11-01', 30);`);
  return { client, file };
}

function fakeParts(record: string[], { failUser = 0 } = {}): SchedulerParts {
  return {
    sync: async userId => {
      record.push(`sync:${userId}`);
      if (userId === failUser) throw new Error("GitHub is down");
    },
    backoffLeft: async () => 0, clearBackoff: async () => {},
    backOff: async userId => { record.push(`backoff:${userId}`); },
    protectBudget: async userId => { record.push(`budget:${userId}`); },
    protectRetention: async userId => { record.push(`retention:${userId}`); },
    minute: async () => { record.push("minute"); },
    deliver: async () => { record.push("deliver"); },
    updateRunners: async () => {},
  };
}

test("sync passes follow the tiers: booting at 11 s, running at 61 s, stopped waits; a failure backs off only that user", async () => {
  const { client } = await database();
  try {
    let now = NOW;
    const record: string[] = [];
    const scheduler = createScheduler({ database: client, parts: fakeParts(record, { failUser: 2 }), clock: () => now, log: () => {} });
    await scheduler.syncDue();
    assert.deepEqual(record.filter(item => item.startsWith("sync")).sort(), ["sync:1", "sync:2", "sync:3"]);
    assert.ok(record.includes("backoff:2"));
    // The fake sync does not write user_syncs; write what the real sync gate writes.
    for (const id of [1, 2, 3]) await client.execute({ sql: `INSERT INTO user_syncs (user_id, next_at, synced_at) VALUES (?, 0, ?)
      ON CONFLICT DO UPDATE SET synced_at = excluded.synced_at`, args: [id, now] });
    record.length = 0;
    now += 11_000;
    await scheduler.syncDue();
    assert.deepEqual(record, ["sync:1"], "after 11 s only the booting user syncs");
    record.length = 0;
    now = NOW + 61_000;
    await scheduler.syncDue();
    assert.deepEqual(record.filter(item => item.startsWith("sync")).sort(), ["sync:1", "sync:2"], "after 61 s the running user syncs too; the stopped user waits");
  } finally { client.close(); }
});

test("the minute pass writes the heartbeat that /api/health reads, and budget runs for each user", async () => {
  const { client } = await database();
  try {
    const record: string[] = [];
    const scheduler = createScheduler({ database: client, parts: fakeParts(record), clock: () => NOW, log: () => {} });
    await scheduler.minute();
    assert.deepEqual(record.sort(), ["budget:1", "budget:2", "budget:3", "minute"]);
    const health = await schedulerHealth(client, "reconcile", () => NOW + 1000);
    assert.equal(health.late, false);
    assert.equal(health.ok, true);
  } finally { client.close(); }
});

test("a slow GitHub for one user does not hold back the other users", async () => {
  const { client } = await database();
  try {
    const record: string[] = [];
    const parts = fakeParts(record);
    parts.sync = async userId => { if (userId === 1) await wait(300); record.push(`sync:${userId}`); };
    const scheduler = createScheduler({ database: client, parts, clock: () => NOW, log: () => {} });
    const pass = scheduler.syncDue();
    await wait(100);
    assert.deepEqual(record.sort(), ["sync:2", "sync:3"], "users 2 and 3 finish while user 1 still waits");
    await pass;
    assert.deepEqual(record.sort(), ["sync:1", "sync:2", "sync:3"]);
  } finally { client.close(); }
});

test("only one scheduler holds the lease; the standby takes over when the leader stops; /api/cron is locked out", async () => {
  const { client, file } = await database();
  const second = createClient({ url: pathToFileURL(file).href });
  try {
    const a: string[] = []; const b: string[] = [];
    const one = createScheduler({ database: client, parts: fakeParts(a), log: () => {}, leaseRetryMs: 50, renewMs: 50 });
    const two = createScheduler({ database: second, parts: fakeParts(b), log: () => {}, leaseRetryMs: 50, renewMs: 50 });
    void one.start();
    await wait(100);
    void two.start();
    await wait(200);
    assert.equal(one.leader, true);
    assert.equal(two.leader, false);
    assert.ok(a.includes("deliver") && a.includes("minute"), "the leader runs its loops at once");
    assert.equal(b.length, 0, "the standby runs nothing");
    // /api/cron (lib/phone/reconcile.ts) uses the same lease, so it answers busy (409).
    await assert.rejects(withLease(client, "scheduled:reconcile", async () => {}), CoordinationBusyError);
    await one.stop(1000);
    await wait(200);
    assert.equal(two.leader, true);
    assert.ok(b.includes("deliver"));
    await two.stop(1000);
  } finally { client.close(); second.close(); }
});

test("stop waits for running work and then gives the lease back", async () => {
  const { client } = await database();
  try {
    let finished = false;
    const parts = fakeParts([]);
    parts.minute = async () => { await wait(200); finished = true; };
    const scheduler = createScheduler({ database: client, parts, log: () => {}, leaseRetryMs: 20, renewMs: 50 });
    void scheduler.start();
    await wait(60);
    await scheduler.stop(2000);
    assert.equal(finished, true);
    const lease = (await client.execute("SELECT 1 FROM coordination_leases WHERE resource = 'scheduled:reconcile'")).rows;
    assert.equal(lease.length, 0);
  } finally { client.close(); }
});
