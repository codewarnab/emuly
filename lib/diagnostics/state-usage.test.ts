import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
import { createStateCounts, stateErrorOf, stateReport } from "./state-usage.ts";

process.env.EMULY_DIAGNOSTICS = "1";
const NOW = Date.parse("2026-11-25T10:00:00.000Z");

async function fixture() {
  const database = createClient({ url: "file::memory:" });
  await migrateHosted(database);
  return { database, states: createStateCounts(() => database) };
}

test("state counts are anonymous: no id, message or time of day is stored", async () => {
  const { database, states } = await fixture();
  try {
    for (let i = 0; i < 3; i++) states.record({ from: "booting", to: "running", reason: "user", region: "EastUs", since: NOW - 40_000, now: NOW });
    states.record({ from: "creating", to: "error", reason: "error", error: stateErrorOf(new Error("phone-private-otter: KVM missing at /home/me")), now: NOW });
    states.record({ from: "running", to: "stopped", reason: "idle", region: "phone-private-otter.example", now: NOW });
    states.record({ from: "running", to: "running", reason: "user", now: NOW });
    await states.settled();
    const rows = (await database.execute("SELECT * FROM diagnostic_states ORDER BY samples DESC")).rows;
    assert.equal(rows.length, 3);
    assert.deepEqual([rows[0]!.from_state, rows[0]!.to_state, rows[0]!.region, rows[0]!.bucket_ms, rows[0]!.samples], ["booting", "running", "EastUs", 65536, 3]);
    assert.ok(rows.some(r => r.error_code === "kvm_missing"));
    const text = JSON.stringify(rows);
    for (const secret of ["phone-private-otter", "/home/me", "example"]) assert.ok(!text.includes(secret), `${secret} stored`);
    assert.ok(!/\d\dT\d\d:/.test(text), "time of day stored");
  } finally { database.close(); }
});

test("GitHub failures map to fixed codes", () => {
  assert.equal(stateErrorOf(Object.assign(new Error("Bad credentials"), { status: 401 })), "github_auth");
  assert.equal(stateErrorOf(Object.assign(new Error("Codespaces spending limit reached"), { status: 403 })), "github_quota");
  assert.equal(stateErrorOf("Phone setup failed."), "setup_failed");
  assert.equal(stateErrorOf(42), "unknown_failure");
});

test("state report hides groups with fewer than 10 samples", async () => {
  const { database, states } = await fixture();
  try {
    for (let i = 0; i < 12; i++) states.record({ from: "booting", to: "running", reason: "user", since: Date.now() - 30_000 });
    for (let i = 0; i < 9; i++) states.record({ from: "running", to: "stopping", reason: "hours_budget" });
    await states.settled();
    const report = await stateReport(database);
    assert.deepEqual(report.transitions.map(t => [t.from, t.to, t.samples, t.p50Ms]), [["booting", "running", 12, 32768]]);
    assert.deepEqual(report.regions, [{ region: "unknown", samples: 21 }]);
  } finally { database.close(); }
});

test("a slow or broken database never slows a state change", async () => {
  const states = createStateCounts(() => ({ batch: () => new Promise((_, reject) => setTimeout(() => reject(new Error("down")), 300)) }) as never);
  const started = performance.now();
  for (let i = 0; i < 100; i++) states.record({ from: "booting", to: "running", reason: "user" });
  assert.ok(performance.now() - started < 50);
  await states.settled();
});
