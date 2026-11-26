import test from "node:test";
import assert from "node:assert/strict";
import { nextState, PHONE_EVENTS, PHONE_STATES, type PhoneEvent, type PhoneState } from "./phone-lifecycle.ts";

// The expected result of every (state, event) pair. "x" is a refusal.
const EXPECTED: Record<PhoneState, Record<PhoneEvent, PhoneState | "x">> = {
  creating: { start: "x", stop: "x", setup_ready: "x", setup_gave_up: "error", stopped: "stopped", delete: "deleted" },
  booting: { start: "booting", stop: "stopping", setup_ready: "running", setup_gave_up: "error", stopped: "stopped", delete: "deleted" },
  running: { start: "running", stop: "stopping", setup_ready: "running", setup_gave_up: "x", stopped: "stopped", delete: "deleted" },
  stopping: { start: "x", stop: "stopping", setup_ready: "x", setup_gave_up: "x", stopped: "stopped", delete: "deleted" },
  stopped: { start: "booting", stop: "stopped", setup_ready: "x", setup_gave_up: "x", stopped: "stopped", delete: "deleted" },
  error: { start: "booting", stop: "stopping", setup_ready: "x", setup_gave_up: "error", stopped: "stopped", delete: "deleted" },
  deleted: { start: "x", stop: "x", setup_ready: "x", setup_gave_up: "x", stopped: "x", delete: "deleted" },
};

test("every state and event pair has the expected result", () => {
  for (const state of PHONE_STATES) {
    for (const event of PHONE_EVENTS) {
      const result = nextState(state, event);
      const expected = EXPECTED[state][event];
      if (expected === "x") {
        assert.equal(result.ok, false, `${state} + ${event}`);
        if (!result.ok) assert.ok(result.reason.length > 0);
      } else assert.deepEqual(result, { ok: true, state: expected }, `${state} + ${event}`);
    }
  }
});

test("a start while stopping says to wait, and an unknown state is refused", () => {
  assert.deepEqual(nextState("stopping", "start"), { ok: false, reason: "The phone is still stopping. Start it again after it stops." });
  assert.equal(nextState("mystery", "start").ok, false);
});
