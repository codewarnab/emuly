import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_NOTE_MAX, cleanAgentNote, readAgentNote } from "./agent-note.ts";

test("a note is decoded, made one line and trimmed", () => {
  assert.equal(cleanAgentNote("  Open   settings \n now "), "Open settings now");
  assert.equal(cleanAgentNote("Type%20the%20e-mail%20%E2%9C%89"), "Type the e-mail ✉");
  assert.equal(cleanAgentNote("100% done"), "100% done", "text that is not percent-encoded stays");
  assert.equal(cleanAgentNote("a\u0000b‮c"), "a b c", "control and format characters go");
});

test("an empty note is null", () => {
  for (const value of [null, undefined, "", "   ", "\n\t"]) assert.equal(cleanAgentNote(value), null);
});

test("a long note is cut with an ellipsis", () => {
  const note = cleanAgentNote("x".repeat(200))!;
  assert.equal(Array.from(note).length, AGENT_NOTE_MAX);
  assert.ok(note.endsWith("…"));
  assert.equal(Array.from(cleanAgentNote("👋".repeat(100))!).length, AGENT_NOTE_MAX, "emoji are not split");
});

test("a token in a note is redacted", () => {
  assert.equal(cleanAgentNote(`Use ghp_${"a".repeat(36)}`), "Use [redacted]");
});

test("readAgentNote reads the X-Emuly-Note header", () => {
  assert.equal(readAgentNote(new Request("https://emuly.test", { headers: { "X-Emuly-Note": "Tap Save" } })), "Tap Save");
  assert.equal(readAgentNote(new Request("https://emuly.test")), null);
});
