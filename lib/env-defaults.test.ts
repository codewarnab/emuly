import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_PORT } from "./env-defaults.ts";

test("the plain JavaScript entry points use the same default port", () => {
  for (const file of ["bin/server.mjs", "bin/emuly.mjs"]) {
    assert.ok(readFileSync(file, "utf8").includes(`process.env.PORT ?? ${DEFAULT_PORT}`), file);
  }
});
