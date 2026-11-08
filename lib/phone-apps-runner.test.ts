import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createApps } from "../phone/runner/apps.mjs";
import { apkUrl, downloadApk } from "../phone/runner/apk-download.mjs";

test("APK downloads reject unsafe protocols and private destinations before consuming bytes", async () => {
  for (const url of ["http://example.com/a.apk", "https://user:pass@example.com/a.apk", "https://example.com:8443/a.apk", "https://example.com/a.apk#fragment", "file:///tmp/a.apk"])
    assert.throws(() => apkUrl(url));
  assert.equal(apkUrl("https://example.com/download?token=private").protocol, "https:");
  for (const ip of ["127.0.0.1", "10.0.2.2", "169.254.169.254", "100.100.100.200", "192.168.0.1", "[::1]", "[::ffff:127.0.0.1]", "[2001:db8::1]", "[2002:7f00:1::]", "[fc00::1]"])
    await assert.rejects(downloadApk(`https://${ip}/app.apk`, { signal: new AbortController().signal, maxBytes: 100, write: async () => { assert.fail("Private targets cannot supply APK bytes"); } }), /public addresses/);
});
test("APK chunks are idempotent, preserve byte order, reject conflicts and produce the actual file digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "apps-test-"));
  try {
    const apps = await createApps({ root, sdk: "/unavailable-sdk", run: async () => { throw new Error("Inspection unavailable"); },
      adb: async () => "", booted: async () => true, exclusive: async (work: () => Promise<unknown>) => work() });
    const key = randomUUID();
    const created = await apps.create({ source: "upload", key, filename: "test.apk", totalBytes: 6 });
    assert.equal((await apps.create({ source: "upload", key, filename: "test.apk", totalBytes: 6 })).id, created.id);
    await assert.rejects(apps.create({ source: "upload", key, filename: "other.apk", totalBytes: 6 }));
    const put = (value: string, offset: number) => apps.content(created.id, Buffer.from(value), offset, createHash("sha256").update(value).digest("hex"));
    assert.equal((await put("abc", 0)).bytesReceived, 3);
    assert.equal((await put("abc", 0)).bytesReceived, 3);
    await assert.rejects(put("def", 0));
    await assert.rejects(apps.complete(created.id));
    assert.equal((await put("def", 3)).bytesReceived, 6);
    const completed = await apps.complete(created.id);
    assert.equal(completed.sha256, createHash("sha256").update("abcdef").digest("hex"));
    assert.equal(completed.stage, "validating");
    await apps.cancel(created.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("Runner restart expires incomplete uploads; cancellation frees phone admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "apps-restart-"));
  const deps = { root, sdk: "/unavailable-sdk", run: async () => "", adb: async () => "", booted: async () => true, exclusive: async (work: () => Promise<unknown>) => work() };
  try {
    const apps = await createApps(deps);
    const operation = await apps.create({ source: "upload", key: randomUUID(), filename: "test.apk", totalBytes: 5 });
    await assert.rejects(apps.create({ source: "upload", key: randomUUID(), filename: "next.apk", totalBytes: 5 }));
    const recovered = await createApps(deps);
    assert.equal(recovered.status(operation.id).stage, "expired");
    const next = await recovered.create({ source: "upload", key: randomUUID(), filename: "next.apk", totalBytes: 5 });
    assert.equal((await recovered.cancel(next.id)).stage, "cancelled");
    const final = await recovered.create({ source: "upload", key: randomUUID(), filename: "final.apk", totalBytes: 5 });
    await recovered.cancel(final.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Installation only succeeds after Android confirms its version; committed installs cannot be cancelled", { timeout: 30_000 }, async () => {
  for (const confirms of [true, false]) {
    const directory = await mkdtemp(join(tmpdir(), "apps-install-"));
    let release!: () => void;
    const installing = new Promise<void>(resolve => { release = resolve; });
    let installed = false;
    try {
      const sdk = join(directory, "sdk");
      await mkdir(join(sdk, "build-tools", "36.0.0"), { recursive: true });
      const apps = await createApps({ root: join(directory, "operations"), sdk,
        run: async (command: string, args: string[]) => {
          if (command === "readlink") return "/usr/lib/jvm/java-21-openjdk/bin/java\n";
          if (args.includes("summary")) return "com.example.fixture 2 1.1\n";
          if (args.includes("min-sdk")) return "23\n";
          return "";
        },
        adb: async (args: string[]) => {
          if (args[0] === "install") { await installing; installed = true; return "Success\n"; }
          return `package:com.example.fixture versionCode:${installed && confirms ? 2 : 1}\n`;
        }, booted: async () => true, exclusive: async (work: () => Promise<unknown>) => work() });
      const operation = await apps.create({ source: "upload", key: randomUUID(), filename: "fixture.apk", totalBytes: 3 });
      await apps.content(operation.id, Buffer.from("apk"), 0, createHash("sha256").update("apk").digest("hex"));
      await apps.complete(operation.id);
      const waitFor = async (done: () => boolean) => {
        for (let attempt = 0; attempt < 1000; attempt++) {
          if (done()) return;
          await new Promise(resolve => setTimeout(resolve, 1));
        }
        assert.fail("Installation did not reach the expected state");
      };
      await waitFor(() => apps.status(operation.id).stage === "installing");
      await assert.rejects(apps.cancel(operation.id), /cannot be cancelled/);
      release();
      await waitFor(() => ["succeeded", "interrupted"].includes(apps.status(operation.id).stage));
      assert.equal(apps.status(operation.id).stage, confirms ? "succeeded" : "interrupted");
      assert.equal(apps.status(operation.id).canCancel, false);
    } finally { release(); await rm(directory, { recursive: true, force: true }); }
  }
});
