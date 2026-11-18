import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { FILES } from "./phone-setup.ts";

/** Matches from "./x.mjs" and import("./x.mjs"), with either quote. */
const LOCAL_IMPORT = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

// Setup uploads only FILES (plus ws.cjs). A runner import that is not in FILES makes the runner
// fail at start on every new or updated phone.
test("every local import of an uploaded runner file is uploaded too", () => {
  const uploaded = new Set<string>([...FILES, "runner/ws.cjs"]);
  for (const file of FILES.filter(name => name.endsWith(".mjs"))) {
    const source = readFileSync(`phone/${file}`, "utf8");
    for (const match of source.matchAll(LOCAL_IMPORT)) {
      const target = posix.normalize(posix.join(posix.dirname(file), match[1] ?? ""));
      assert.ok(uploaded.has(target), file + " imports " + target + ", which is not in FILES");
    }
  }
});
