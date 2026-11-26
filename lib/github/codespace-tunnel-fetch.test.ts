import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("codespace tunnel calls send the GitHub token only through githubFetch", () => {
  const source = readFileSync("lib/github/codespace-tunnel.ts", "utf8");
  // githubFetch allows only api.github.com and github.com, refuses redirects and stops after 15 s.
  assert.doesNotMatch(source, /(?<![\w.])fetch\(/, "no plain fetch( call");
  assert.equal([...source.matchAll(/githubFetch\(`https:\/\/api\.github\.com\/user\/codespaces\//g)].length, 3);
  assert.doesNotMatch(source, /\bapi = "|\bapi\?: string/, "codespaceExec takes no api host");
});
