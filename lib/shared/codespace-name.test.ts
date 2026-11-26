import test from "node:test";
import assert from "node:assert/strict";
import { assertCodespaceName, isCodespaceName, isMachineName } from "./codespace-name.ts";

test("codespace names allow only word characters and dashes, up to 100", () => {
  for (const name of ["automatic-spoon-1", "a", "x".repeat(100), "a_b"]) assert.equal(isCodespaceName(name), true, name);
  for (const name of ["", "x".repeat(101), "a.b", "a/b", "a b", "evil.example.com", 5, null]) assert.equal(isCodespaceName(name), false, String(name));
  assert.equal(isMachineName("standardLinux32gb"), true);
  assert.throws(() => assertCodespaceName("a/b"), /Invalid codespace name/);
  assert.throws(() => assertCodespaceName("a/b", () => new RangeError("custom")), RangeError);
  assert.doesNotThrow(() => assertCodespaceName("ok-name"));
});
