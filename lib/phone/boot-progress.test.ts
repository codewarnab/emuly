import test from "node:test";
import assert from "node:assert/strict";
import { bootProgress } from "./boot-progress.ts";

const START = "2026-11-27T10:00:00.000Z";
const at = (seconds: number) => Date.parse(START) + seconds * 1000;
const phone = (fields: Partial<Parameters<typeof bootProgress>[0]>) =>
  ({ id: "p1", state: "running", android_state: "booting", created_at: "2026-11-01T00:00:00.000Z", last_started_at: START, ...fields });

test("each stored state maps to one stage an agent can read", () => {
  const cases: [Partial<Parameters<typeof bootProgress>[0]>, string][] = [
    [{ state: "pending" }, "codespace_creating"],
    [{ state: "booting", state_detail: null }, "codespace_starting"],
    [{ state: "booting", state_detail: "Booting Android" }, "android_setup"],
    [{ state: "booting", state_detail: "Setup failed", setup_failed: 1 }, "failed"],
    [{ android_state: "booting" }, "emulator_booting"],
    [{ android_state: "idle" }, "emulator_booting"],
    [{ android_state: "ready" }, "ready"],
    [{ android_state: "failed" }, "failed"],
    [{ android_state: "stopping" }, "stopping"],
    [{ state: "stopping" }, "stopping"],
    [{ state: "stopped" }, "stopped"],
    [{ state: "error" }, "failed"],
  ];
  for (const [fields, stage] of cases) assert.equal(bootProgress(phone(fields), at(10)).stage, stage, JSON.stringify(fields));
});

test("a start counts from last_started_at; a new phone counts from created_at", () => {
  assert.equal(bootProgress(phone({}), at(95)).elapsed_s, 95);
  assert.equal(bootProgress(phone({ state: "pending", created_at: START, last_started_at: null }), at(30)).elapsed_s, 30);
  assert.equal(bootProgress(phone({ android_state: "ready" }), at(30)).elapsed_s, null, "no clock once ready");
});

test("the setup step shows only while setup runs", () => {
  assert.equal(bootProgress(phone({ state: "booting", state_detail: "Booting Android" }), at(10)).step, "Booting Android");
  assert.equal(bootProgress(phone({ state_detail: "old text" }), at(10)).step, undefined);
});

test("ready_at shows only while Android is ready, so an old value does not hide a new boot", () => {
  const readyAt = "2026-11-27T09:00:00.000Z";
  assert.equal(bootProgress(phone({ android_state: "ready", android_ready_at: readyAt }), at(1)).ready_at, readyAt);
  assert.equal(bootProgress(phone({ android_state: "booting", android_ready_at: readyAt }), at(1)).ready_at, null);
});

test("a quick boot has no note; a slow boot says it is normal; a very slow boot says what to do", () => {
  const quick = bootProgress(phone({}), at(4 * 60 + 59));
  assert.equal(quick.note, undefined);
  assert.equal(quick.hint, undefined);
  const slow = bootProgress(phone({}), at(6 * 60 + 10));
  assert.match(slow.note!, /after 6 min\. This is normal/);
  assert.match(slow.hint!, /wait_for=ready/);
  const stuck = bootProgress(phone({}), at(16 * 60));
  assert.match(stuck.note!, /after 16 min\. This is longer than normal/);
  assert.match(stuck.hint!, /POST stop/);
  assert.equal(bootProgress(phone({ android_state: "ready" }), at(60 * 60)).note, undefined, "no note once ready");
});
