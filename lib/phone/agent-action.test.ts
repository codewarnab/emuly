import { test } from "node:test";
import assert from "node:assert/strict";
import { adbEventMeta, parseAdbAction, parseWmSize } from "./agent-action.ts";

test("taps parse with or without a shell prefix and round fractional coordinates", () => {
  assert.deepEqual(parseAdbAction(["shell", "input", "tap", "540", "1200"]), { type: "tap", x: 540, y: 1200 });
  assert.deepEqual(parseAdbAction(["input", "tap", "10.4", "20.6"]), { type: "tap", x: 10, y: 21 });
  assert.equal(parseAdbAction(["shell", "input", "tap", "540"]), null);
  assert.equal(parseAdbAction(["shell", "input", "tap", "540", "1200", "3"]), null);
});

test("coordinates must be finite non-negative numbers", () => {
  assert.equal(parseAdbAction(["input", "tap", "-5", "10"]), null);
  assert.equal(parseAdbAction(["input", "tap", "abc", "10"]), null);
  assert.equal(parseAdbAction(["input", "tap", "", "10"]), null);
  assert.equal(parseAdbAction(["input", "tap", "Infinity", "10"]), null);
  assert.equal(parseAdbAction(["input", "tap", "1e3", "10"]), null);
});

test("swipes parse both endpoints and ignore the optional duration", () => {
  assert.deepEqual(parseAdbAction(["shell", "input", "swipe", "900", "1800", "120", "600"]),
    { type: "swipe", from: { x: 900, y: 1800 }, to: { x: 120, y: 600 } });
  assert.deepEqual(parseAdbAction(["input", "swipe", "900", "1800", "120", "600", "300"]),
    { type: "swipe", from: { x: 900, y: 1800 }, to: { x: 120, y: 600 } });
  assert.equal(parseAdbAction(["input", "swipe", "900", "1800", "120"]), null);
  assert.equal(parseAdbAction(["input", "swipe", "900", "1800", "120", "bad"]), null);
});

test("key events map to navigation intents and everything else stays opaque", () => {
  for (const [token, key] of [["4", "back"], ["KEYCODE_BACK", "back"], ["3", "home"], ["KEYCODE_HOME", "home"],
    ["187", "recent"], ["KEYCODE_APP_SWITCH", "recent"]] as const)
    assert.deepEqual(parseAdbAction(["shell", "input", "keyevent", token]), { type: "key", key });
  assert.deepEqual(parseAdbAction(["shell", "input", "keyevent", "KEYCODE_ENTER"]), { type: "key", key: "other" });
  assert.equal(parseAdbAction(["shell", "input", "keyevent"]), null);
});

test("typed text is reported as a bare action and never retains its payload", () => {
  const action = parseAdbAction(["shell", "input", "text", "hello%sworld", "secret"]);
  assert.deepEqual(action, { type: "text" });
  assert.equal(action !== null && "text" in action, false);
  assert.equal(JSON.stringify(action).includes("secret"), false);
  assert.equal(parseAdbAction(["shell", "input", "text"]), null);
});

test("a single joined shell string is split on whitespace", () => {
  assert.deepEqual(parseAdbAction(["shell", "input tap 1 2"]), { type: "tap", x: 1, y: 2 });
  assert.deepEqual(parseAdbAction(["shell input swipe 1 2 3 4"]),
    { type: "swipe", from: { x: 1, y: 2 }, to: { x: 3, y: 4 } });
  assert.deepEqual(parseAdbAction(["shell", "input keyevent KEYCODE_HOME"]), { type: "key", key: "home" });
});

test("installs and screenshots become labelled commands", () => {
  assert.deepEqual(parseAdbAction(["install", "-r", "@file0"]), { type: "command", label: "Installing app" });
  assert.deepEqual(parseAdbAction(["install-multiple", "-r", "@file0", "@file1"]), { type: "command", label: "Installing app" });
  assert.deepEqual(parseAdbAction(["shell", "screencap"]), { type: "command", label: "Taking screenshot" });
  assert.deepEqual(parseAdbAction(["exec-out", "screencap", "-p"]), { type: "command", label: "Taking screenshot" });
});

test("event meta carries the action only, merged with the agent key", () => {
  assert.deepEqual(JSON.parse(adbEventMeta(["shell", "input", "tap", "540", "1200"], 0)!),
    { action: { type: "tap", x: 540, y: 1200 } });
  assert.deepEqual(JSON.parse(adbEventMeta(["shell", "input", "tap", "540", "1200"], 0, 7)!),
    { agent_key_id: 7, action: { type: "tap", x: 540, y: 1200 } });
  assert.deepEqual(JSON.parse(adbEventMeta(["shell", "dumpsys", "battery"], 0, 7)!), { agent_key_id: 7 });
  assert.equal(adbEventMeta(["shell", "dumpsys", "battery"], 0), null);
});

test("failed adb calls keep attribution but never claim an action", () => {
  assert.equal(adbEventMeta(["shell", "input", "tap", "540", "1200"], 1), null);
  assert.deepEqual(JSON.parse(adbEventMeta(["shell", "input", "tap", "540", "1200"], 1, 7)!), { agent_key_id: 7 });
});

test("event meta never stores typed text", () => {
  const meta = adbEventMeta(["shell", "input", "text", "hello%sworld"], 0)!;
  assert.deepEqual(JSON.parse(meta), { action: { type: "text" } });
  assert.equal(meta.includes("hello"), false);
});

test("wm size prefers an override over the physical panel", () => {
  assert.deepEqual(parseWmSize("Physical size: 1080x2400\n"), { width: 1080, height: 2400 });
  assert.deepEqual(parseWmSize("Physical size: 1080x2400\nOverride size: 720x1600\n"), { width: 720, height: 1600 });
  // The override can be listed before the physical size; it still wins.
  assert.deepEqual(parseWmSize("Override size: 720x1600\nPhysical size: 1080x2400"), { width: 720, height: 1600 });
  assert.deepEqual(parseWmSize("Physical size: 1080x2400\r\nOverride size: 720x1600\r\n"), { width: 720, height: 1600 });
  assert.deepEqual(parseWmSize("  Physical size: 1080x2400"), { width: 1080, height: 2400 });
});

test("wm size output without a usable size is null", () => {
  assert.equal(parseWmSize(""), null);
  assert.equal(parseWmSize("Physical size: 0x0"), null);
  assert.equal(parseWmSize("Physical size: 1080x"), null);
  assert.equal(parseWmSize("Physical size: widex2400"), null);
  assert.equal(parseWmSize("Override size: 720x1600x2"), null);
});

test("unrelated adb commands are not agent actions", () => {
  for (const args of [[], ["shell"], ["shell", "dumpsys", "battery"], ["logcat", "-d"],
    ["exec-out", "cat", "/sdcard/x.png"], ["uninstall", "com.example.app"], ["get-state"], ["push", "@file0", "/sdcard/x"]])
    assert.equal(parseAdbAction(args), null, args.join(" "));
});
