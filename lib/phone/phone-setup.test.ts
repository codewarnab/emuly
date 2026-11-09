import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

test("setup packages an Apps runner that loads with plain Node outside the repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "emuly-package-"));
  try {
    // Decode the actual upload payload without executing its shell commands.
    // The setup dependency uses TypeScript parameter properties, so this process needs transformation.
    const script = execFileSync(process.execPath, ["--conditions=react-server", "--experimental-transform-types",
      "--input-type=module", "--eval", `
        const { setupScript } = await import(process.argv[1]);
        process.stdout.write(setupScript());
      `, pathToFileURL(resolve("lib/phone/phone-setup.ts")).href], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
    });
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
