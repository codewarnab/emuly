import test from "node:test";
import assert from "node:assert/strict";
import { logError } from "./log-error.ts";
import { redactSecrets } from "./redact.ts";

test("logError writes the place, name and code, never the message", () => {
  const lines: string[] = [];
  const error = Object.assign(new TypeError("token ghp_abcdefghijklmnop leaked at 10.0.0.1"), { code: "ECONNRESET",
    cause: { code: "ENOTFOUND" } });
  logError("background", error, line => lines.push(line));
  assert.deepEqual(lines, ["[error] where=background name=TypeError code=ECONNRESET cause=ENOTFOUND"]);
  logError("x", "a plain string with a secret", line => lines.push(line));
  assert.equal(lines[1], "[error] where=x name=string");
});

test("redactSecrets removes every token type and the extra secrets", () => {
  const text = [
    "ghp_aaaaaaaaaaaaaaaaaaaa", "gho_bbbbbbbbbbbb", "ghs_cccccccccccc", "ghu_dddddddddddd", "github_pat_11AAAAAAAA_bbbb",
    "url?token=abc&ticket=def", "secret=xyz", "cookies=c1", "Authorization: Bearer emuly_key_1", "my-runner-key",
  ].join("\n");
  const out = redactSecrets(text, ["my-runner-key", "", undefined]);
  for (const secret of ["aaaa", "bbbbbbbb", "cccc", "dddd", "11AAAAAAAA", "abc", "def", "xyz", "c1", "emuly_key_1", "my-runner-key"]) {
    assert.ok(!out.includes(secret), `${secret} in ${out}`);
  }
});
