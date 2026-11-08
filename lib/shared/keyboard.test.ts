import assert from "node:assert/strict";
import test from "node:test";
import { shortcutKey, filterCommands } from "./keyboard.ts";
const key = (value: string, extra = {}) => ({ key: value, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra });
test("shortcuts leave typing and unintended modifiers alone", () => {
  assert.equal(shortcutKey(key("s"), true), null);
  assert.equal(shortcutKey(key("s", { ctrlKey: true }), false), null);
  assert.equal(shortcutKey(key("s", { shiftKey: true }), false), null);
  assert.equal(shortcutKey(key("k", { ctrlKey: true, altKey: true }), false), null);
  assert.equal(shortcutKey(key("k", { ctrlKey: true, metaKey: true }), false), null);
  assert.equal(shortcutKey(key("k", { ctrlKey: true }), true), "command");
  assert.equal(shortcutKey(key("k", { metaKey: true }), false), "command");
  assert.equal(shortcutKey(key("?", { shiftKey: true }), false), "?");
  assert.equal(shortcutKey(key("w"), false), "w");
});
test("command search matches all words regardless of case or order", () => {
  const commands = [{label: "Open phone-7f2a"}, {label: "Theme: Dark", keywords: "appearance"}];
  assert.deepEqual(filterCommands(commands, "  7F2A open "), [commands[0]]);
  assert.deepEqual(filterCommands(commands, "appearance DARK"), [commands[1]]);
  assert.deepEqual(filterCommands(commands, ""), commands);
  assert.deepEqual(filterCommands(commands, "delete"), []);
});
