import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";

const cli = resolve("bin/emuly.mjs");

test("emuly dev rejects bad arguments before any network call", () => {
  for (const [args, message] of [[[], /Usage: emuly dev/], [["phone-a", "abc"], /"abc" is not a port/],
    [["phone-a", "--adb-port", "80"], /--adb-port is a port/], [["phone-a", "--to", "x"], /Unknown option --to/]] as const) {
    const result = spawnSync(process.execPath, [cli, "dev", ...args], { encoding: "utf8", env: { ...process.env, EMULY_BASE_URL: "http://127.0.0.1:1" } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});

test("emuly dev inside the phone's own codespace uses the local emulator with no tunnel", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "emuly-dev-"));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/phones/phone-a/links") return response.end(JSON.stringify({ links: [], codespace_name: "cs-1", github_login: "octocat" }));
    if (request.url === "/v1/phones/phone-a") return response.end(JSON.stringify({ state: "running" }));
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    writeFileSync(join(directory, "adb"), `#!/bin/sh
case "$*" in
  version) echo 'Android Debug Bridge version 1.0.41' ;;
  devices) printf 'List of devices attached\\nemulator-5554\\tdevice\\n' ;;
  *getprop*) echo 34 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    const port = (server.address() as { port: number }).port;
    const child = spawn(process.execPath, [cli, "dev", "phone-a"], { env: { ...process.env, PATH: `${directory}:${process.env.PATH}`,
      EMULY_BASE_URL: `http://127.0.0.1:${port}`, EMULY_KEY: "test", CODESPACE_NAME: "cs-1", EMULY_CLI_AUTO_UPDATE: "0", ANDROID_HOME: "", ANDROID_SDK_ROOT: "" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const code = await new Promise(done => child.on("close", done));
    assert.equal(code, 0, stderr);
    const line = JSON.parse(stdout.trim().split("\n").pop()!);
    assert.equal(line.ok, true);
    assert.equal(line.serial, "emulator-5554");
    assert.equal(line.route, "local");
    assert.equal(line.api_level, 34);
    assert.deepEqual(line.env, { ANDROID_SERIAL: "emulator-5554" });
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
