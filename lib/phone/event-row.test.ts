import { test } from "node:test";
import assert from "node:assert/strict";
import { eventRow } from "./event-row.ts";

const ts = "2026-11-20T10:15:30.000Z";

test("an agent adb row shows the note and keeps the command as detail", () => {
  const row = eventRow({ ts, kind: "adb", message: "adb shell input tap [agent key 4]",
    meta: JSON.stringify({ agent_key_id: 4, action: { type: "tap", x: 540, y: 1200 }, note: "Tap Save" }) });
  assert.equal(row.agent, true);
  assert.deepEqual(row.parts, [{ type: "text", value: "Tap Save" }]);
  assert.equal(row.detail, "adb shell input tap");
  assert.equal(row.error, false);
});

test("an agent adb row with no note shows a label made from the action", () => {
  const row = eventRow({ ts, kind: "adb", message: "adb shell input tap [agent key 4]",
    meta: JSON.stringify({ agent_key_id: 4, action: { type: "tap", x: 540, y: 1200 } }) });
  assert.deepEqual(row.parts, [{ type: "text", value: "Tap at (540, 1200)" }]);
  assert.equal(row.detail, "adb shell input tap");
});

test("an agent command with no action and no note shows the command once", () => {
  const row = eventRow({ ts, kind: "adb", message: "adb shell dumpsys battery (exit 1) [agent key 4]",
    meta: JSON.stringify({ agent_key_id: 4 }) });
  assert.deepEqual(row.parts, [{ type: "text", value: "adb shell dumpsys battery (exit 1)" }]);
  assert.equal(row.detail, undefined);
  assert.equal(row.error, true, "a failed command is an error row");
});

test("an agent screenshot row shows the label and the call", () => {
  const row = eventRow({ ts, kind: "agent", message: "Took a screenshot [agent key 4]",
    meta: JSON.stringify({ agent_key_id: 4, command: "GET screenshot" }) });
  assert.deepEqual(row.parts, [{ type: "text", value: "Took a screenshot" }]);
  assert.equal(row.detail, "GET screenshot");
});

test("other rows and bad meta stay as before", () => {
  const row = eventRow({ ts, kind: "step", message: "Phone ready", meta: null });
  assert.equal(row.agent, undefined);
  assert.equal(row.detail, undefined);
  assert.equal(row.ok, true);
  assert.deepEqual(row.parts, [{ type: "text", value: "Phone runner ready" }]);
  assert.equal(eventRow({ ts, kind: "adb", message: "adb shell id", meta: "{bad" }).detail, undefined);
});
