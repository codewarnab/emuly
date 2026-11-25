import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// runner.mjs is never imported by a test (it starts servers at load), and tsc does not parse it.
// A syntax error there ships a runner that crashes at start, so every runner file is checked here.
test("every runner file parses", () => {
  const dir = join(process.cwd(), "phone", "runner");
  const files = readdirSync(dir).filter(name => name.endsWith(".mjs"));
  assert.ok(files.includes("runner.mjs"));
  for (const name of files) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", join(dir, name)], { stdio: "pipe" }), name);
  }
});
