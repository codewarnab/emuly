import { test } from "node:test";
import assert from "node:assert/strict";
import { lastLogin } from "./last-login.ts";

test("lastLogin keeps a GitHub username", () => {
  assert.equal(lastLogin("codewarnab"), "codewarnab");
  assert.equal(lastLogin("a-b-1"), "a-b-1");
});

test("lastLogin drops anything that is not a GitHub username", () => {
  for (const value of [undefined, null, "", "-a", "a-", "a--b", "a b", "<script>", "a".repeat(40)]) {
    assert.equal(lastLogin(value), null, String(value));
  }
});
