import test from "node:test";
import assert from "node:assert/strict";
import { duration, timeAgo, utcLabel } from "./relative-time.ts";

const now = Date.parse("2026-11-07T16:30:00Z");

test("timeAgo picks the largest whole unit", () => {
  assert.equal(timeAgo("2026-11-07T16:29:58Z", now), "just now");
  assert.equal(timeAgo("2026-11-07T16:29:15Z", now), "just now");
  assert.equal(timeAgo("2026-11-07T16:24:00Z", now), "6 min ago");
  assert.equal(timeAgo("2026-11-07T14:00:00Z", now), "2 h ago");
  assert.equal(timeAgo("2026-11-04T16:30:00Z", now), "3 d ago");
});

test("duration shows seconds, minutes, then hours", () => {
  assert.equal(duration(4_000), "4s");
  assert.equal(duration(380_000), "6m 20s");
  assert.equal(duration(3_900_000), "1h 5m");
  assert.equal(duration(-5), "0s");
});

test("utcLabel keeps the full UTC time for the tooltip", () => {
  assert.equal(utcLabel("2026-11-07T16:18:37.123Z"), "2026-11-07 16:18:37 UTC");
});
