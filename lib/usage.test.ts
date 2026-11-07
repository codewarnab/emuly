import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateUsage, reconcileUsage, type Run } from "./usage.ts";

const run = (cores: number, started_at: string, stopped_at: string | null): Run =>
  ({ phone_id: `phone-${cores}`, cores, started_at, stopped_at });

test("billing countdown adds live phone time once, clamps other usage, and falls back to the estimate", () => {
  const runs = [run(4, "2026-11-01T00:00:00Z", null)];
  const atReport = estimateUsage(runs, 120, () => Date.parse("2026-11-01T01:00:00Z"));
  const live = estimateUsage(runs, 120, () => Date.parse("2026-11-01T02:00:00Z"));
  assert.deepEqual(reconcileUsage(live, atReport, 20), {
    reported_core_hours: 20, phonelink_core_hours: 8, other_core_hours: 12, hours_left_at_current_rate: 24,
  });
  assert.equal(reconcileUsage(live, atReport, 1).other_core_hours, 0);
  assert.equal(reconcileUsage(live, atReport, 1).hours_left_at_current_rate, 28);
  assert.equal(reconcileUsage(live, atReport, null).hours_left_at_current_rate, 28);
  assert.equal(reconcileUsage(live, atReport, 121).hours_left_at_current_rate, 0);
  assert.equal(reconcileUsage({ ...live, running: [] }, atReport, 20).hours_left_at_current_rate, null);
});

test("budget counts mixed cores, clips prior months, and accrues open runs only up to the clock", () => {
  let time = Date.parse("2026-11-01T02:00:00Z");
  const runs = [
    run(4, "2026-10-31T23:00:00Z", "2026-11-01T01:00:00Z"),
    run(2, "2026-11-01T00:30:00Z", null),
    run(8, "2026-10-01T00:00:00Z", "2026-10-31T23:59:59Z"),
    run(4, "2026-12-01T00:00:00Z", null),
    run(2, "2026-11-01T01:00:00Z", "2026-11-02T00:00:00Z"),
  ];
  const usage = estimateUsage(runs, 120, () => time);
  assert.deepEqual(usage, { allowance_core_hours: 120, used_core_hours: 9,
    running: [{ id: "phone-2", cores: 2 }], hours_left_at_current_rate: 55.5, month: "2026-11", estimated: true });
  time += 3_600_000;
  assert.equal(estimateUsage(runs, 120, () => time).used_core_hours, 13);
});

test("UTC calendar months reset at midnight, including year and leap-month boundaries", () => {
  for (const [before, after] of [
    ["2026-12-31T23:00:00Z", "2027-01-01T00:00:00Z"],
    ["2028-02-29T23:00:00Z", "2028-03-01T00:00:00Z"],
  ]) {
    const runs = [run(4, before, null)];
    assert.equal(estimateUsage(runs, 180, () => Date.parse(after) - 1).used_core_hours, 4 - 4 / 3_600_000);
    const usage = estimateUsage(runs, 180, () => Date.parse(after));
    assert.equal(usage.used_core_hours, 0);
    assert.equal(usage.month, after.slice(0, 7));
    assert.equal(usage.hours_left_at_current_rate, 45);
  }
  // Local December is still November in UTC.
  assert.equal(estimateUsage([], 120, () => Date.parse("2026-12-01T00:15:00+05:30")).month, "2026-11");
});

test("exhausted budgets clamp remaining hours to zero; stopped phones have no depletion time", () => {
  const clock = () => Date.parse("2026-11-02T00:00:00Z");
  assert.equal(estimateUsage([run(4, "2026-11-01T00:00:00Z", null)], 1, clock).hours_left_at_current_rate, 0);
  assert.equal(estimateUsage([], 0, clock).hours_left_at_current_rate, null);
  const usage = estimateUsage([run(2, "2026-11-01T00:00:00Z", "2026-11-01T01:00:00Z")], 10, clock);
  assert.equal(usage.used_core_hours, 2);
  assert.deepEqual(usage.running, []);
  assert.equal(usage.hours_left_at_current_rate, null);
});
