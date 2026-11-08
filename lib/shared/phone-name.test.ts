import assert from "node:assert/strict";
import test from "node:test";
import { candidatePhoneName, phoneName, PHONE_ID } from "./phone-name.ts";

test("phone names stay stable so existing phones keep their name", () => {
  assert.equal(phoneName("phone-c3f5872b3f2235e3"), "phone-swift-whale");
  assert.equal(phoneName("phone-7f2a"), "phone-frosty-robin");
  assert.equal(phoneName("phone-quiet-falcon"), "phone-quiet-falcon");
  assert.equal(phoneName("phone-aaaa"), phoneName("phone-aaaa"));
});

test("validation accepts readable and legacy ids but rejects paths", () => {
  assert.ok(PHONE_ID.test(candidatePhoneName(123456789)));
  assert.ok(PHONE_ID.test("phone-c3f5872b3f2235e3"));
  assert.ok(!PHONE_ID.test("phone-../evil"));
});
