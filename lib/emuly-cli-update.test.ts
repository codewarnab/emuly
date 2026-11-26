import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

/** Runs a copy of the CLI whose fetch serves `body` as the new emuly.mjs from any URL. */
function update(base: string, body: string) {
  const directory = mkdtempSync(join(tmpdir(), "emuly-update-"));
  try {
    const cli = join(directory, "emuly.mjs");
    copyFileSync(resolve("bin/emuly.mjs"), cli);
    const sha = createHash("sha256").update(body).digest("hex");
    const fake = join(directory, "fake-fetch.mjs");
    writeFileSync(fake, `globalThis.fetch = async (url, init = {}) => new Response(init.method === "HEAD" ? null : ${JSON.stringify(body)},
      { headers: { "x-emuly-cli-sha256": ${JSON.stringify(sha)} } });`);
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(fake).href, cli, "no-such-command"], {
      encoding: "utf8", env: { ...process.env, EMULY_BASE_URL: base, EMULY_KEY: "test", EMULY_CLI_AUTO_UPDATE: "" } });
    return { replaced: readFileSync(cli, "utf8") === body, backup: existsSync(`${cli}.bak`), stderr: result.stderr };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const NEW = "console.log('new copy');\n";

test("the CLI updates itself only over https or to this computer", () => {
  const plain = update("http://emuly.example", NEW);
  assert.equal(plain.replaced, false, plain.stderr);
  assert.match(plain.stderr, /not https/);
  const secure = update("https://emuly.example", NEW);
  assert.equal(secure.replaced, true, secure.stderr);
  assert.equal(secure.backup, true, "the old copy stays as emuly.mjs.bak");
  assert.equal(update("http://127.0.0.1:4321", NEW).replaced, true);
});

test("an update that does not parse leaves the working CLI in place", () => {
  const broken = update("https://emuly.example", "this is not javascript (\n");
  assert.equal(broken.replaced, false, broken.stderr);
  assert.match(broken.stderr, /did not parse/);
});
