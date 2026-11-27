import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { request } from "node:http";
import { directKeyFile, issueDirectTicket } from "./direct-ticket.ts";
import { createDirectServer } from "../../phone/runner/direct-server.mjs";

const require = createRequire(import.meta.url);
const ws = require("next/dist/compiled/ws");
const SECRET = "s".repeat(40);
const ORIGIN = "https://emuly.xyz";
const base = { codespaceName: "phone-a", phoneId: "ph_a", userId: 7, sessionId: "s", quality: "auto", origin: ORIGIN };

async function start(options: { key?: boolean; maxViewers?: number; upgradesPerMinute?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "emuly-direct-"));
  const keyFile = join(dir, ".direct-key");
  if (options.key !== false) await writeFile(keyFile, directKeyFile("phone-a", SECRET)!, { mode: 0o600 });
  const attached: unknown[] = [];
  const server = createDirectServer({ ws, keyFile, port: 0, keyPollMs: 50, maxViewers: options.maxViewers,
    upgradesPerMinute: options.upgradesPerMinute, qualities: { auto: true, saver: true },
    attach: (client: { send: (data: string) => void }, quality: string) => { attached.push(quality); client.send("hello"); } });
  await server.start();
  return { server, attached, keyFile, async done() { server.stop(); await rm(dir, { recursive: true, force: true }); } };
}

function open(port: number, path: string, origin = ORIGIN): Promise<{ ok: true; socket: InstanceType<typeof ws> } | { ok: false; status?: number }> {
  return new Promise(resolve => {
    const socket = new ws(`ws://127.0.0.1:${port}${path}`, { origin });
    socket.once("message", () => resolve({ ok: true, socket }));
    socket.once("unexpected-response", (_req: unknown, res: { statusCode: number }) => resolve({ ok: false, status: res.statusCode }));
    socket.once("error", () => resolve({ ok: false }));
  });
}

function httpStatus(port: number, method: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path }, res => { res.resume(); resolve(res.statusCode!); });
    req.on("error", reject);
    req.end();
  });
}

const ticket = (over = {}) => encodeURIComponent(issueDirectTicket({ ...base, ...over }, { secret: SECRET })!);

test("with no key file, the direct port does not listen", async () => {
  const t = await start({ key: false });
  try {
    assert.equal(t.server.listening, false);
    // It starts once the private setup writes the key.
    await writeFile(t.keyFile, directKeyFile("phone-a", SECRET)!);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(t.server.listening, true);
  } finally { await t.done(); }
});

test("an invalid key file keeps the port closed", async () => {
  const t = await start({ key: false });
  try {
    await writeFile(t.keyFile, "not-a-key\nphone-a\n");
    await new Promise(r => setTimeout(r, 200));
    assert.equal(t.server.listening, false);
  } finally { await t.done(); }
});

test("every path except a ticketed GET /stream returns 404", async () => {
  const t = await start();
  try {
    const port = t.server.port;
    for (const path of ["/", "/health", "/adb", "/links/relay", "/screenshot", "/agent-device/x", "/stream", "/recording/file"]) {
      assert.equal(await httpStatus(port, "GET", path), 404, path);
      assert.equal(await httpStatus(port, "POST", path), 404, path);
    }
    for (const path of ["/adb", "/links/relay", "/health", "/stream", `/streamx?ticket=${ticket()}`]) {
      const result = await open(port, path);
      assert.equal(result.ok, false, path);
    }
  } finally { await t.done(); }
});

test("a valid ticket opens the stream with the signed quality", async () => {
  const t = await start();
  try {
    const result = await open(t.server.port, `/stream?ticket=${ticket({ quality: "saver" })}`);
    assert.equal(result.ok, true);
    assert.deepEqual(t.attached, ["saver"]);
    if (result.ok) result.socket.close();
  } finally { await t.done(); }
});

test("no ticket, an old ticket, another phone's ticket, a replayed ticket, and a wrong Origin all fail", async () => {
  const t = await start();
  try {
    const port = t.server.port;
    assert.equal((await open(port, "/stream")).ok, false);
    const old = encodeURIComponent(issueDirectTicket(base, { secret: SECRET, now: Date.now() - 31_000 })!);
    assert.equal((await open(port, `/stream?ticket=${old}`)).ok, false);
    assert.equal((await open(port, `/stream?ticket=${ticket({ codespaceName: "phone-b" })}`)).ok, false);
    const once = ticket();
    const first = await open(port, `/stream?ticket=${once}`);
    assert.equal(first.ok, true);
    assert.equal((await open(port, `/stream?ticket=${once}`)).ok, false);
    assert.equal((await open(port, `/stream?ticket=${ticket()}`, "https://evil.example")).ok, false);
    if (first.ok) first.socket.close();
  } finally { await t.done(); }
});

test("revoke closes the user's open socket within 1 second and refuses older tickets", async () => {
  const t = await start();
  try {
    const result = await open(t.server.port, `/stream?ticket=${ticket()}`);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const started = Date.now();
    const closed = new Promise(resolve => result.socket.once("close", resolve));
    const before = ticket();
    assert.equal(t.server.revoke(99), 0);
    assert.equal(t.server.revoke(7), 1);
    await closed;
    assert.ok(Date.now() - started < 1000);
    assert.equal((await open(t.server.port, `/stream?ticket=${before}`)).ok, false);
  } finally { await t.done(); }
});

test("at most 8 viewers and 20 upgrade tries a minute", async () => {
  const t = await start({ maxViewers: 2, upgradesPerMinute: 4 });
  try {
    const port = t.server.port;
    const a = await open(port, `/stream?ticket=${ticket()}`);
    const b = await open(port, `/stream?ticket=${ticket()}`);
    assert.equal(a.ok && b.ok, true);
    assert.deepEqual(await open(port, `/stream?ticket=${ticket()}`), { ok: false, status: 503 });
    assert.deepEqual(await open(port, `/stream?ticket=${ticket()}`), { ok: false, status: 503 });
    assert.deepEqual(await open(port, `/stream?ticket=${ticket()}`), { ok: false, status: 429 });
    for (const r of [a, b]) if (r.ok) r.socket.close();
  } finally { await t.done(); }
});

function put(port: number, path: string, body: Buffer, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "PUT", path, headers: { "content-type": "application/octet-stream", ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("PUT /adb runs the ticket's command once and refuses a missing or used ticket", async () => {
  const { issueUploadTicket } = await import("./direct-ticket.ts");
  const dir = await mkdtemp(join(tmpdir(), "emuly-direct-"));
  const keyFile = join(dir, ".direct-key");
  await writeFile(keyFile, directKeyFile("phone-a", SECRET)!);
  const seen: { args: unknown; bytes: string }[] = [];
  const server = createDirectServer({ ws, keyFile, port: 0, keyPollMs: 50, attach: () => {},
    upload: async (req: AsyncIterable<Buffer>, payload: { args: unknown }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.push({ args: payload.args, bytes: Buffer.concat(chunks).toString() });
      return { exit_code: 0, stdout: "Success", stderr: "" };
    } });
  await server.start();
  try {
    const { ticket } = issueUploadTicket({ codespaceName: "phone-a", phoneId: "ph_a", userId: 7, args: ["push", "@file0", "/sdcard/x"],
      timeout_s: 30, files: [{ name: "x", size: 5, sha256: "b".repeat(64) }] }, { secret: SECRET })!;
    const auth = { authorization: `Emuly-Ticket ${ticket}` };
    const first = await put(server.port, "/adb", Buffer.from("hello"), auth);
    assert.equal(first.status, 200);
    assert.equal(first.body.stdout, "Success");
    assert.deepEqual(seen, [{ args: ["push", "@file0", "/sdcard/x"], bytes: "hello" }]);
    assert.equal((await put(server.port, "/adb", Buffer.from("hello"), auth)).status, 401);
    const none = await put(server.port, "/adb", Buffer.from("hello"), {});
    assert.equal(none.status, 401);
    assert.equal(none.body.error, "invalid_ticket");
    assert.equal(seen.length, 1);
    assert.equal(await httpStatus(server.port, "POST", "/adb"), 404);
  } finally { server.stop(); await rm(dir, { recursive: true, force: true }); }
});

function rawRequest(port: number, method: string, path: string, headers: Record<string, string>, body?: Buffer): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("PUT /app-installs/<id>/content stores a browser chunk only with a chunk ticket for that operation and origin", async () => {
  const { issueChunkTicket, issueUploadTicket } = await import("./direct-ticket.ts");
  const dir = await mkdtemp(join(tmpdir(), "emuly-direct-"));
  const keyFile = join(dir, ".direct-key");
  await writeFile(keyFile, directKeyFile("phone-a", SECRET)!);
  const seen: { id: string; bytes: string; offset: number; digest: string }[] = [];
  const server = createDirectServer({ ws, keyFile, port: 0, keyPollMs: 50, attach: () => {},
    chunk: async (id: string, bytes: Buffer, offset: number, digest: string) => { seen.push({ id, bytes: bytes.toString(), offset, digest }); return { id, bytesReceived: offset + bytes.length }; } });
  await server.start();
  const op = "11111111-2222-3333-4444-555555555555";
  const other = "99999999-2222-3333-4444-555555555555";
  const path = `/app-installs/${op}/content`;
  const digest = "a".repeat(64);
  const good = issueChunkTicket({ codespaceName: "phone-a", phoneId: "ph_a", userId: 7, operationId: op, origin: ORIGIN }, { secret: SECRET })!.ticket;
  const headers = (ticket: string, origin = ORIGIN) => ({ origin, authorization: `Emuly-Chunk ${ticket}`, "content-type": "application/octet-stream", "x-upload-offset": "0", "x-chunk-sha256": digest });
  try {
    // The preflight names what the real request may send. It gives no access by itself.
    const preflight = await rawRequest(server.port, "OPTIONS", path, { origin: ORIGIN, "access-control-request-method": "PUT" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], ORIGIN);
    assert.match(String(preflight.headers["access-control-allow-headers"]), /authorization/);

    const ok = await rawRequest(server.port, "PUT", path, headers(good), Buffer.from("hello"));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["access-control-allow-origin"], ORIGIN);
    assert.deepEqual(seen, [{ id: op, bytes: "hello", offset: 0, digest }]);
    // One ticket covers every chunk of the operation.
    assert.equal((await rawRequest(server.port, "PUT", path, headers(good), Buffer.from("again"))).status, 200);

    // Another origin, another operation, another phone, a stream or adb ticket, or no ticket: refused, with no CORS header.
    const foreign = await rawRequest(server.port, "PUT", path, headers(good, "https://evil.example"), Buffer.from("x"));
    assert.equal(foreign.status, 401);
    assert.equal(foreign.headers["access-control-allow-origin"], undefined);
    assert.equal((await rawRequest(server.port, "PUT", `/app-installs/${other}/content`, headers(good), Buffer.from("x"))).status, 401);
    const otherPhone = issueChunkTicket({ codespaceName: "phone-b", phoneId: "ph_b", userId: 7, operationId: op, origin: ORIGIN }, { secret: SECRET })!.ticket;
    assert.equal((await rawRequest(server.port, "PUT", path, headers(otherPhone), Buffer.from("x"))).status, 401);
    assert.equal((await rawRequest(server.port, "PUT", path, headers(decodeURIComponent(ticket())), Buffer.from("x"))).status, 401);
    const adb = issueUploadTicket({ codespaceName: "phone-a", phoneId: "ph_a", userId: 7, args: ["push", "@file0", "/sdcard/x"], timeout_s: 30,
      files: [{ name: "x", size: 1, sha256: digest }] }, { secret: SECRET })!.ticket;
    assert.equal((await rawRequest(server.port, "PUT", path, headers(adb), Buffer.from("x"))).status, 401);
    const expired = issueChunkTicket({ codespaceName: "phone-a", phoneId: "ph_a", userId: 7, operationId: op, origin: ORIGIN }, { secret: SECRET, now: Date.now() - 700_000 })!.ticket;
    assert.equal((await rawRequest(server.port, "PUT", path, headers(expired), Buffer.from("x"))).status, 401);
    assert.equal((await rawRequest(server.port, "PUT", path, { ...headers(good), authorization: "" }, Buffer.from("x"))).status, 401);

    // Bad input with a good ticket is refused before the chunk is stored.
    assert.equal((await rawRequest(server.port, "PUT", path, { ...headers(good), "x-chunk-sha256": "nope" }, Buffer.from("x"))).status, 400);
    // An oversize chunk is refused from Content-Length. The socket closes, so the client may see a reset instead of the 413.
    const big = await rawRequest(server.port, "PUT", path, headers(good), Buffer.alloc(4 * 1024 * 1024 + 1)).catch((error: { code?: string }) => ({ status: error.code }));
    assert.ok(big.status === 413 || big.status === "ECONNRESET" || big.status === "EPIPE");
    assert.equal(seen.length, 2);

    // A revoke for the user refuses the older chunk ticket.
    server.revoke(7);
    assert.equal((await rawRequest(server.port, "PUT", path, headers(good), Buffer.from("x"))).status, 401);
  } finally { server.stop(); await rm(dir, { recursive: true, force: true }); }
});
