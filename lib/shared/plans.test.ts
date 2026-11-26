import test from "node:test";
import assert from "node:assert/strict";
import { PLANS, phoneHours } from "./plans.ts";

test("plans give 30 and 45 phone hours on a 4-core phone", () => {
  assert.equal(PLANS.free.coreHours, 120);
  assert.equal(phoneHours("free"), 30);
  assert.equal(phoneHours("pro"), 45);
  assert.equal(phoneHours("pro", 2), 90);
});
