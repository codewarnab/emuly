import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePhoneTransition, decideRunChanges, STOP_GRACE_MS, START_GRACE_MS, START_PENDING_DETAIL } from "./phone-lifecycle.ts";

test("reconciled idle stops cannot close usage before its start or after the observation", () => {
  const started = "2026-11-07T01:00:00.000Z";
  const now = Date.parse("2026-11-07T02:00:00.000Z");
  for (const [lastUsed, expected] of [
    ["2026-11-07T00:00:00.000Z", started],
    ["2026-11-07T01:15:00.000Z", "2026-11-07T01:45:00.000Z"],
    ["2026-11-07T03:00:00.000Z", "2026-11-07T02:00:00.000Z"],
    ["invalid", "2026-11-07T02:00:00.000Z"],
  ]) {
    const changes = decideRunChanges({
      previous: { state: "running", last_started_at: started, last_stopped_at: null,
        cores: 2, machine: "basicLinux32gb", idle_timeout_min: 30 },
      codespace: { state: "Shutdown", last_used_at: lastUsed },
      state: "stopped", source: "reconciled", open: { id: 7, cores: 2, started_at: started }, now,
    });
    assert.deepEqual(changes, { close: { id: 7, stoppedAt: expected }, create: undefined }, lastUsed);
  }
});

test("a phone leaves stopping after the stop grace when an external restart reports Available", () => {
  const now = Date.parse("2026-11-07T12:00:00.000Z");
  const previous = { state: "stopping", last_started_at: null, last_stopped_at: null, retention_at: null, retention_min: 43200 };
  const stateFor = (codespace: string, stopRequestedAt: number | null) => decidePhoneTransition({
    previous, codespace: { state: codespace }, androidState: "idle", setupAvailable: false, stopRequestedAt, now,
  }).state;
  assert.equal(STOP_GRACE_MS, 180_000);
  assert.equal(stateFor("Available", now - 30_000), "stopping");
  assert.equal(stateFor("Available", now - 10 * 60_000), "booting");
  assert.equal(stateFor("Available", null), "booting");
  assert.equal(stateFor("ShuttingDown", now - 60 * 60_000), "stopping");
});

test("GitHub's Unavailable state keeps the phone booting with a recovery hint", () => {
  const result = decidePhoneTransition({
    previous: { state: "booting", last_started_at: null, last_stopped_at: null, retention_at: null } as never,
    codespace: { state: "Unavailable" } as never, androidState: "idle", setupAvailable: true,
    stopRequestedAt: null, now: Date.parse("2026-11-13T00:00:00Z"),
  });
  assert.equal(result.state, "booting");
  assert.match(result.detail ?? "", /Unavailable.*Stop, then Start/);
});

test("an Emuly start stays booting while GitHub still reports Shutdown, but only within the grace", () => {
  const now = Date.parse("2026-11-14T04:49:00.000Z");
  const stateFor = (detail: string | null, startedAgo: number) => decidePhoneTransition({
    previous: { state: "booting", state_detail: detail, last_started_at: new Date(now - startedAgo).toISOString(),
      last_stopped_at: null, retention_at: null, retention_min: 43200 },
    codespace: { state: "Shutdown" }, androidState: "idle", setupAvailable: true, stopRequestedAt: null, now,
  });
  assert.equal(stateFor(START_PENDING_DETAIL, 10_000).state, "booting");
  assert.equal(stateFor(START_PENDING_DETAIL, 10_000).detail, START_PENDING_DETAIL);
  assert.equal(stateFor(START_PENDING_DETAIL, START_GRACE_MS + 1).state, "stopped");
  // A booting phone that GitHub stopped by itself is stopped at once.
  assert.equal(stateFor(null, 10_000).state, "stopped");
});
