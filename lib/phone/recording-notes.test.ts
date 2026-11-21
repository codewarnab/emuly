import { test } from "node:test";
import assert from "node:assert/strict";
import { notesVtt, vttTime } from "./recording-notes.ts";

test("notes become WebVTT cues that last until the next note", () => {
  assert.equal(vttTime(3661.5), "01:01:01.500");
  assert.equal(notesVtt([]), "WEBVTT\n");
  assert.equal(notesVtt([{ t_s: 0, text: "Open the app" }, { t_s: 2.25, text: "Tap -->\n\nSubmit" }], 4000),
    "WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.250\nOpen the app\n\n2\n00:00:02.250 --> 00:00:04.000\nTap ->\nSubmit\n");
});
