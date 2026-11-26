import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inputTextArg } from "../../phone/runner/adb-protocol.mjs";

test("POST /text escapes shell characters and refuses control characters, so text cannot run a command", () => {
  assert.equal(inputTextArg("a b;c|d$(e)"), "a%sb\\;c\\|d\\$\\(e\\)");
  for (const text of ["hi\nreboot", "hi\rreboot", "a\tb", "a\u0000b", "a\u007fb", "a" + String.fromCharCode(0x2028) + "b"])
    assert.throws(() => inputTextArg(text), /control characters/, JSON.stringify(text));
  for (const text of ["", "x".repeat(501)]) assert.throws(() => inputTextArg(text), /bad text/);
  const route = /"POST \/text"[^]*?\n  \},/.exec(readFileSync("phone/runner/runner.mjs", "utf8"))?.[0] ?? "";
  assert.match(route, /arg = inputTextArg\(text\)[^]*"input", "text", arg\]/);
});
