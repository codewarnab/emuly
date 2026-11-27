import { test } from "node:test";
import assert from "node:assert/strict";
import { eventStream, HEARTBEAT, nextReadDelay } from "./event-stream.ts";

test("a stream reads fast only near a change, and slows down when quiet", () => {
  const options = { intervalMs: 1500, quietIntervalMs: 4000, quietAfterMs: 60_000 };
  assert.equal(nextReadDelay(-Infinity, 1_000_000, options), 4000, "no change yet: quiet");
  assert.equal(nextReadDelay(1_000_000, 1_000_000, options), 1500, "just changed: fast");
  assert.equal(nextReadDelay(1_000_000, 1_059_999, options), 1500, "still inside the active window");
  assert.equal(nextReadDelay(1_000_000, 1_060_000, options), 4000, "60 s with no change: quiet");
  // Without a quiet interval the stream keeps one speed, as before.
  assert.equal(nextReadDelay(-Infinity, 0, { intervalMs: 400 }), 400);
  assert.equal(nextReadDelay(-Infinity, 0), 1500);
});

test("the first snapshot does not count as a change, a later new value does", async () => {
  const values: unknown[] = [{ v: 1 }, HEARTBEAT, { v: 2 }, HEARTBEAT, HEARTBEAT, undefined];
  const reads: number[] = [];
  const response = eventStream(new Request("http://x/"), async () => { reads.push(Date.now()); return values.shift(); },
    { intervalMs: 10, quietIntervalMs: 120, quietAfterMs: 1_000 });
  const text = await response.text();
  assert.equal(text, 'data: {"v":1}\n\n: heartbeat\n\ndata: {"v":2}\n\n: heartbeat\n\n: heartbeat\n\n');
  const gaps = reads.slice(1).map((at, i) => at - reads[i]);
  // Quiet after the first snapshot and the heartbeat. Fast after {"v":2} changed the value.
  assert.ok(gaps[0] >= 100 && gaps[1] >= 100, `quiet gaps ${gaps}`);
  assert.ok(gaps[2] < 100 && gaps[3] < 100 && gaps[4] < 100, `fast gaps ${gaps}`);
});
