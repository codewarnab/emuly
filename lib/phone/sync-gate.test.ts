import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
import { CoordinationBusyError } from "../data/coordination.ts";
import { GitHubError } from "../github/github.ts";
import { createSyncGate, nextSyncAt, SYNC_INTERVAL_MS } from "./sync-gate.ts";
import { recordSchedulerRun, schedulerHealth, SCHEDULER_LATE_MS } from "./scheduler-health.ts";

async function fixture(sync: (userId: number) => Promise<void>) {
  const database = createClient({ url: "file::memory:" });
  await migrateHosted(database);
  await database.execute(`INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
    VALUES (1, 1, 'fixture', x'00', 'codespace', '2026-11-01', '2026-11-01')`);
  let now = 1_000_000;
  const gate = createSyncGate({ database, sync, clock: () => now });
  return { database, gate, advance: (ms: number) => { now += ms; }, clock: () => now };
}

test("page syncs run at most once per interval, also when two start together", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; });
  try {
    assert.deepEqual(await Promise.all([f.gate.run(1, "due"), f.gate.run(1, "due")]).then(r => r.sort()), ["skipped", "synced"]);
    assert.equal(await f.gate.run(1, "due"), "skipped");
    f.advance(SYNC_INTERVAL_MS);
    assert.equal(await f.gate.run(1, "due"), "synced");
    assert.equal(calls, 2);
  } finally { f.database.close(); }
});

test("the scheduler always syncs, and a page load right after it skips GitHub", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; });
  try {
    await f.gate.run(1, "due");
    assert.equal(await f.gate.run(1, "always"), "synced");
    assert.equal(await f.gate.run(1, "due"), "skipped");
    assert.equal(calls, 2);
  } finally { f.database.close(); }
});

test("a failed page sync stores the error without throwing, and the next good sync clears it", async () => {
  let fail = true;
  const f = await fixture(async () => { if (fail) throw new GitHubError("Bad credentials", 401); });
  try {
    assert.equal(await f.gate.run(1, "due"), "failed");
    assert.equal((await f.gate.lastError(1))?.kind, "signin");
    fail = false;
    f.advance(SYNC_INTERVAL_MS);
    assert.equal(await f.gate.run(1, "due"), "synced");
    assert.equal(await f.gate.lastError(1), null);
  } finally { f.database.close(); }
});

test("the scheduler gets sync errors back for its own retry handling", async () => {
  const f = await fixture(async () => { throw new CoordinationBusyError(); });
  try {
    await assert.rejects(f.gate.run(1, "always"), CoordinationBusyError);
    f.advance(SYNC_INTERVAL_MS);
    assert.equal(await f.gate.run(1, "due"), "synced", "a page treats a held phone lock as current state");
  } finally { f.database.close(); }
});

test("a busy GitHub delays the next page sync by its retry time", () => {
  assert.equal(nextSyncAt(0, null), SYNC_INTERVAL_MS);
  assert.equal(nextSyncAt(0, { kind: "busy", message: "GitHub is busy.", retryAfter: 120 }), 120_000);
  assert.equal(nextSyncAt(0, { kind: "signin", message: "GitHub sign-in expired." }), SYNC_INTERVAL_MS);
});

test("scheduler health is late with no run, current after a run, and late again after 5 minutes", async () => {
  const f = await fixture(async () => {});
  try {
    assert.equal((await schedulerHealth(f.database, "reconcile", f.clock)).late, true);
    await assert.rejects(recordSchedulerRun(f.database, "reconcile", async () => { throw new Error("fixture"); }, f.clock));
    const failed = await schedulerHealth(f.database, "reconcile", f.clock);
    assert.deepEqual([failed.late, failed.ok], [false, false]);
    await recordSchedulerRun(f.database, "reconcile", async () => {}, f.clock);
    assert.equal((await schedulerHealth(f.database, "reconcile", f.clock)).ok, true);
    f.advance(SCHEDULER_LATE_MS + 1);
    assert.equal((await schedulerHealth(f.database, "reconcile", f.clock)).late, true);
  } finally { f.database.close(); }
});
