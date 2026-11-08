import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRunChanges } from "./phone-lifecycle.ts";

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
