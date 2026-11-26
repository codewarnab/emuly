import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("codespace tunnel calls send the GitHub token only through githubApi", () => {
  const source = readFileSync("lib/github/codespace-tunnel.ts", "utf8");
  // githubApi goes through githubFetch, which allows only api.github.com and github.com, refuses redirects and stops after 15 s.
  assert.doesNotMatch(source, /(?<![\w.])fetch\(/, "no plain fetch( call");
  // One loader reads the codespace connection for all three callers.
  assert.equal([...source.matchAll(/githubApi\(token, `\/user\/codespaces\//g)].length, 1);
  assert.equal([...source.matchAll(/await loadCodespaceTunnel\(/g)].length, 3);
  assert.doesNotMatch(source, /githubFetch\(/, "no direct githubFetch call");
  assert.doesNotMatch(source, /\bapi = "|\bapi\?: string/, "codespaceExec takes no api host");
});
