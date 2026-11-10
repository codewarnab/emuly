import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT_DEVICE_VERSION } from "../agent-device-version.ts";

// The setup dependency uses TypeScript parameter properties, so this process needs transformation.
// Node 26 transforms types by default and dropped the flag; older releases need it.
const transform = execFileSync(process.execPath, ["--help"], { encoding: "utf8" }).includes("--experimental-transform-types")
  ? ["--experimental-transform-types"] : [];

function generatedScript() {
  return execFileSync(process.execPath, ["--conditions=react-server", ...transform,
    "--input-type=module", "--eval", `
      const { setupScript } = await import(process.argv[1]);
      process.stdout.write(setupScript());
    `, pathToFileURL(resolve("lib/phone/phone-setup.ts")).href], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
  });
}

test("the setup check waits for runner health instead of returning working at once", () => {
  const script = generatedScript();
  assert.match(script, /for i in \$\(seq 1 75\)/);
  assert.match(script, /EMULY_READY/);
  assert.match(script, /EMULY_WORKING/);
  assert.match(script, /EMULY_FAILED/);
});

test("RUN starts an early emulator boot before setup when the AVD already exists", () => {
  const script = generatedScript();
  const encoded = script.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d > "run\.sh"/)?.[1];
  assert.ok(encoded, "run.sh is part of the upload payload");
  const run = Buffer.from(encoded, "base64").toString("utf8");
  const avdCheck = run.indexOf('[ -d "$HOME/.android/avd/t.avd" ]');
  const earlyBoot = run.indexOf("bash scripts/boot.sh cold");
  const setup = run.indexOf("bash scripts/setup.sh");
  assert.ok(avdCheck >= 0, "RUN checks for the AVD");
  assert.ok(earlyBoot > avdCheck && setup > earlyBoot, "the early boot starts before setup");
  assert.match(run, /early-boot\.log/);
});

test("run.sh and the launcher export the pinned agent-device version", () => {
  const script = generatedScript();
  const line = `export AGENT_DEVICE_VERSION=${AGENT_DEVICE_VERSION}`;
  assert.match(AGENT_DEVICE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(script.includes(`${line}\n`), "the setup launcher exports the pinned version");
  const encoded = script.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d > "run\.sh"/)?.[1];
  assert.ok(encoded, "run.sh is part of the upload payload");
  const run = Buffer.from(encoded, "base64").toString("utf8");
  assert.ok(run.includes(`${line}\n`), "run.sh exports the same pinned version");
});

test("setup packages an Apps runner that loads with plain Node outside the repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "emuly-package-"));
  try {
    // Decode the actual upload payload without executing its shell commands.
    const script = generatedScript();
    for (const [, body, name] of script.matchAll(/echo '([A-Za-z0-9+/=]+)' \| base64 -d > "([^"]+)"/g)) {
      const target = resolve(root, name);
      assert.ok(target.startsWith(root + sep));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(body, "base64"));
    }
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", `
      const { createApps, MAX_APK, CHUNK_SIZE } = await import("./runner/apps.mjs");
      console.log(JSON.stringify({ createApps: typeof createApps, MAX_APK, CHUNK_SIZE }));
    `], { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.deepEqual(JSON.parse(output), { createApps: "function", MAX_APK: 250 * 1024 * 1024, CHUNK_SIZE: 4 * 1024 * 1024 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
