import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { httpsUrl, publicAddress, safeDownload } from "../../phone/runner/safe-download.mjs";
import { createFileFetches, fetchDest } from "../../phone/runner/file-fetch.mjs";

const never = async () => { assert.fail("A blocked URL must not reach a socket or write bytes"); };
const lookupTo = (...addresses: string[]) => (async () => addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4 }))) as never;
const fetchOnce = (url: string, lookup = lookupTo("93.184.216.34")) =>
  safeDownload(url, { signal: new AbortController().signal, maxBytes: 100, write: never, lookup });

test("URL rules: HTTPS on 443 only, no credentials, no fragment, at most 4096 characters", () => {
  for (const url of ["http://example.com/a", "https://example.com:8443/a", "https://u:p@example.com/a", "https://example.com/a#x",
    "file:///etc/passwd", "ftp://example.com/a", "data:text/plain,hi", `https://example.com/${"a".repeat(4100)}`, "not a url"])
    assert.throws(() => httpsUrl(url), (error: { code: string }) => error.code === "invalid_url", url);
  assert.equal(httpsUrl("https://example.com:443/a?b=c").hostname, "example.com");
});

test("Address rules: loopback, private, metadata, CGNAT, and IPv6 transition forms are not public", () => {
  for (const address of ["127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "100.100.100.100", "224.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fd00::1", "fe80::1", "64:ff9b::7f00:1",
    "2002:7f00:1::", "2001:db8::1", "::"])
    assert.equal(publicAddress(address), false, address);
  for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) assert.equal(publicAddress(address), true, address);
});

test("A blocked address fails before any socket: literal IPs, and DNS answers", async () => {
  for (const url of ["https://127.0.0.1/a", "https://[::1]/a", "https://[::ffff:127.0.0.1]/a", "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.1/a", "https://100.64.0.1/a", "https://[fd00::1]/a"])
    await assert.rejects(fetchOnce(url), (error: { code: string }) => error.code === "private_url", url);
  // DNS rebinding and split answers: one private answer is enough to refuse.
  await assert.rejects(fetchOnce("https://rebind.example/a", lookupTo("127.0.0.1")), (error: { code: string }) => error.code === "private_url");
  await assert.rejects(fetchOnce("https://split.example/a", lookupTo("93.184.216.34", "10.0.0.5")), (error: { code: string }) => error.code === "private_url");
  await assert.rejects(fetchOnce("https://empty.example/a", lookupTo()), (error: { code: string }) => error.code === "private_url");
});

test("Phone paths: shared storage or /data/local/tmp, plain characters, a file name", () => {
  for (const dest of ["/system/x", "/sdcard", "/sdcard/", "/sdcard/Download/", "/sdcard/../data/x", "/sdcard/./x", "/sdcard//x",
    "/sdcard/a b", "/sdcard/a'b", "/sdcard/a;rm", "/sdcard/a\nb", "/sdcard/$(id)", "/data/data/x", "relative/x", 42, "/sdcard/" + "a".repeat(260)])
    assert.throws(() => fetchDest(dest), (error: { code: string }) => error.code === "invalid_dest", String(dest));
  assert.equal(fetchDest("/sdcard/Download/test-data_1.json"), "/sdcard/Download/test-data_1.json");
  assert.equal(fetchDest("/data/local/tmp/x.bin"), "/data/local/tmp/x.bin");
});

type Options = { files?: Set<string>; body?: Buffer; downloadError?: Error; pushError?: Error; ready?: boolean };
async function setup(options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), "emuly-fetch-test-"));
  const files = options.files ?? new Set<string>();
  const pushed: { dest: string; bytes: Buffer }[] = [];
  const logs: string[] = [];
  const body = options.body ?? Buffer.from("hello phone");
  const fetches = await createFileFetches({ root, booted: async () => options.ready ?? true,
    exists: async dest => files.has(dest),
    push: async (local, dest) => { if (options.pushError) throw options.pushError; pushed.push({ dest, bytes: await readFile(local) }); files.add(dest); },
    download: (async (_url: string, { write, signal }: { write: (b: Buffer, t: number | null) => Promise<void>; signal: AbortSignal }) => {
      if (options.downloadError) throw options.downloadError;
      signal.throwIfAborted();
      await write(body, body.length);
      return { url: _url, bytes: body.length, contentType: "application/json" };
    }) as never,
    log: line => logs.push(line) });
  return { root, fetches, pushed, logs, files, body, done: async () => { await fetches.idle(); await rm(root, { recursive: true, force: true }); } };
}
const start = (extra: Record<string, unknown> = {}) => ({ key: randomUUID(), url: "https://files.example/data.json?token=SECRET", dest: "/sdcard/Download/data.json", ...extra });

test("A fetch downloads, hashes, pushes, deletes its temp file, and logs the host only", async () => {
  const t = await setup();
  try {
    const job = await t.fetches.create(start());
    assert.equal(job.stage, "downloading");
    assert.equal(job.url_host, "files.example");
    assert.equal(JSON.stringify(job).includes("SECRET"), false, "the view never shows the query string");
    await t.fetches.idle();
    const done = t.fetches.status(job.id);
    assert.equal(done.stage, "done");
    assert.equal(done.sha256, createHash("sha256").update(t.body).digest("hex"));
    assert.equal(done.bytes_received, t.body.length);
    assert.deepEqual(t.pushed.map(item => [item.dest, item.bytes.toString()]), [["/sdcard/Download/data.json", "hello phone"]]);
    assert.deepEqual(await readdir(t.root), [], "no temp file is left");
    assert.equal(t.logs.length, 1);
    assert.match(t.logs[0], /host=files\.example/);
    assert.equal(t.logs[0].includes("SECRET"), false);
  } finally { await t.done(); }
});

test("A wrong sha256 pushes nothing and leaves no temp file", async () => {
  const t = await setup();
  try {
    const job = await t.fetches.create(start({ sha256: "0".repeat(64) }));
    await t.fetches.idle();
    const result = t.fetches.status(job.id);
    assert.equal(result.stage, "failed");
    assert.equal(result.error_code, "checksum_mismatch");
    assert.deepEqual(t.pushed, []);
    assert.deepEqual(await readdir(t.root), []);
  } finally { await t.done(); }
});

test("An existing dest is not replaced unless overwrite is true", async () => {
  const t = await setup({ files: new Set(["/sdcard/Download/data.json"]) });
  try {
    await assert.rejects(t.fetches.create(start()), (error: { code: string }) => error.code === "dest_exists");
    const job = await t.fetches.create(start({ overwrite: true }));
    await t.fetches.idle();
    assert.equal(t.fetches.status(job.id).stage, "done");
  } finally { await t.done(); }
});

test("A download error fails the job with its code, and the temp file is gone", async () => {
  const error = Object.assign(new Error("The download URL must resolve to public addresses."), { status: 400, code: "private_url" });
  const { AppError } = await import("../../phone/runner/safe-download.mjs");
  const t = await setup({ downloadError: new AppError(400, "private_url", error.message) });
  try {
    const job = await t.fetches.create(start());
    await t.fetches.idle();
    assert.equal(t.fetches.status(job.id).error_code, "private_url");
    assert.deepEqual(t.pushed, []);
    assert.deepEqual(await readdir(t.root), []);
  } finally { await t.done(); }
});

test("Keys: the same key returns the same job; a key with other input is refused", async () => {
  const t = await setup();
  try {
    const input = start();
    const first = await t.fetches.create(input);
    assert.equal((await t.fetches.create(input)).id, first.id);
    await assert.rejects(t.fetches.create({ ...input, dest: "/sdcard/Download/other.json" }), (error: { code: string }) => error.code === "key_conflict");
  } finally { await t.done(); }
});

test("Limits: input checks, a phone that is not ready, and 6 starts a minute", async () => {
  const t = await setup();
  try {
    for (const bad of [null, {}, start({ key: "x" }), start({ url: "http://files.example/a" }), start({ dest: "/system/a" }),
      start({ sha256: "ABC" }), start({ overwrite: "yes" })])
      await assert.rejects(t.fetches.create(bad), (error: { status: number }) => error.status === 400);
    for (let index = 0; index < 6; index++) { await t.fetches.create(start({ dest: `/sdcard/Download/f${index}` })); await t.fetches.idle(); }
    await assert.rejects(t.fetches.create(start({ dest: "/sdcard/Download/f7" })), (error: { code: string }) => error.code === "rate_limit");
  } finally { await t.done(); }
  const idle = await setup({ ready: false });
  try { await assert.rejects(idle.fetches.create(start()), (error: { code: string }) => error.code === "phone_not_ready"); }
  finally { await idle.done(); }
});

test("A runner restart deletes temp files that a killed runner left", async () => {
  const root = await mkdtemp(join(tmpdir(), "emuly-fetch-test-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(root, "old.bin"), "left over");
  await createFileFetches({ root, booted: async () => true, exists: async () => false, push: async () => {} });
  assert.deepEqual(await readdir(root), []);
  await rm(root, { recursive: true, force: true });
});
