import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("sign-in asks GitHub for the codespace scope only, with no query that adds more", () => {
  // Comments may name the old billing link; only the code counts.
  const source = readFileSync("app/auth/start/route.ts", "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.deepEqual([...source.matchAll(/scope: ([^,\n]+)/g)].map(match => match[1]), ['"codespace"']);
  assert.doesNotMatch(source, /billing/);
});
