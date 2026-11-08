import { test } from "node:test";
import assert from "node:assert/strict";
import { phoneStatus } from "./phone-status.ts";

test("setup failure categories depend on the explicit field regardless of display wording", () => {
  for (const detail of ["Phone setup failed. Try again.", "Could not reach the codespace.", "Installation needs another attempt.", null]) {
    const failed = phoneStatus({ state: "booting", setup_failed: 1, state_detail: detail });
    assert.equal(failed.kind, "needsyou");
    assert.equal(failed.label, "setup failed");
    assert.ok(failed.description);
    assert.equal(phoneStatus({ state: "booting", setup_failed: 0, state_detail: detail }).kind, "booting");
    assert.equal(phoneStatus({ state: "booting", state_detail: detail }).kind, "booting");
  }
  assert.equal(phoneStatus({ state: "running", android_state: "ready", setup_failed: 1 }).kind, "running");
});
