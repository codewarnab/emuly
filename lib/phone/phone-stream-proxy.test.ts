import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { attachPhoneStreams } from "./phone-stream-proxy.mjs";
import { issueStreamTicket } from "./phone-stream-ticket.ts";
const WS = createRequire(import.meta.url)("next/dist/compiled/ws/index.js");

test("a ShuttingDown codespace closes with 4001, records the state, and never falls back", async t => {
  const upstreamHttp = createServer();
  upstreamHttp.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"));
  upstreamHttp.listen(0, "127.0.0.1"); await once(upstreamHttp, "listening");
  const upstreamPort = (upstreamHttp.address() as { port: number }).port;
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
  let failed = 0, dropped = 0;
  let recorded: { state?: string } | undefined;
  const server = createServer();
  attachPhoneStreams(server, () => {}, {
    snapshot: async () => ({ id: 1, name: "owned-space", state: "ShuttingDown" }),
    record: async (_userId: number, _phoneId: string, codespace: { state?: string }) => { recorded = codespace; },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const ticket = issueStreamTicket({ userId: 1, phoneId: "a", origin, cookie: "session=synthetic",
    open: async () => ({ url: `ws://127.0.0.1:${upstreamPort}/stream`,
      headers: { "X-Github-Token": "gho_SECRET123" }, signal: new AbortController().signal, route: "forwarded" as const, viewers: 1,
      release() {}, failed() { failed++; }, drop() { dropped++; } }) });
  const browser = new WS(`ws://127.0.0.1:${port}/app/phones/a/stream?ticket=${ticket}&quality=auto`,
    { headers: { Origin: origin, Cookie: "session=synthetic" } });
  try {
    const [code, reason] = await once(browser, "close");
    assert.equal(code, 4001);
    assert.equal(String(reason), "phone_stopped");
    // The tunnel cannot survive a stopped codespace either, so the lease must not mark a fallback.
    assert.equal(failed, 0);
    assert.equal(dropped, 1, "the dead bridge is dropped for the next start");
    assert.equal(recorded?.state, "ShuttingDown");
    assert.ok(warnings.some(line => line.includes("action=phone_stopped") && line.includes("state=ShuttingDown")));
    assert.ok(warnings.every(line => !line.includes("gho_SECRET123")), "logs never contain the credential");
  } finally {
    browser.terminate();
    await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => upstreamHttp.close(() => r()))]);
  }
});

test("an Available codespace keeps the existing tunnel fallback", async t => {
  const upstreamHttp = createServer();
  upstreamHttp.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"));
  upstreamHttp.listen(0, "127.0.0.1"); await once(upstreamHttp, "listening");
  const upstreamPort = (upstreamHttp.address() as { port: number }).port;
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
  let failed = 0, dropped = 0;
  const server = createServer();
  attachPhoneStreams(server, () => {}, {
    snapshot: async () => ({ id: 1, name: "owned-space", state: "Available" }),
    record: async () => { throw new Error("Available states are never recorded from the stream proxy"); },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const ticket = issueStreamTicket({ userId: 1, phoneId: "a", origin, cookie: "session=synthetic",
    open: async () => ({ url: `ws://127.0.0.1:${upstreamPort}/stream`,
      headers: { "X-Github-Token": "gho_SECRET123" }, signal: new AbortController().signal, route: "forwarded" as const, viewers: 1,
      release() {}, failed() { failed++; }, drop() { dropped++; } }) });
  const browser = new WS(`ws://127.0.0.1:${port}/app/phones/a/stream?ticket=${ticket}`,
    { headers: { Origin: origin, Cookie: "session=synthetic" } });
  try {
    const code = await new Promise<number>(resolve => {
      browser.on("error", () => {});
      browser.on("close", (value: number) => resolve(value));
    });
    assert.equal(code, 1006);
    assert.equal(failed, 1);
    assert.equal(dropped, 0);
    assert.ok(warnings.some(line => line.includes("action=fallback_tunnel") && line.includes("state=Available")));
  } finally {
    browser.terminate();
    await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => upstreamHttp.close(() => r()))]);
  }
});

test("socket proxy forwards video and input privately and releases the upstream lease", async () => {
  const upstreamHttp = createServer();
  const upstreams = new WS.WebSocketServer({ server: upstreamHttp });
  upstreamHttp.listen(0, "127.0.0.1"); await once(upstreamHttp, "listening");
  const upstreamPort = (upstreamHttp.address() as { port: number }).port;
  const received = Promise.withResolvers<string>();
  upstreams.on("connection", (socket: InstanceType<typeof WS>, req: { headers: Record<string, string>; url: string }) => {
    assert.equal(req.headers["x-github-token"], "synthetic-private-token");
    assert.equal(req.url, "/stream?quality=saver");
    socket.send(Buffer.from([1, 2, 3]));
    socket.on("message", (data: Buffer) => received.resolve(data.toString()));
  });
  const server = createServer(); attachPhoneStreams(server, () => {});
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const released = Promise.withResolvers<void>();
  const origin = `http://127.0.0.1:${port}`;
  const ticket = issueStreamTicket({ userId: 1, phoneId: "a", origin, cookie: "session=synthetic",
    open: async () => ({ url: `ws://127.0.0.1:${upstreamPort}/stream`, headers: { "X-Github-Token": "synthetic-private-token" },
      signal: new AbortController().signal, release: () => released.resolve() }) });
  const browser = new WS(`ws://127.0.0.1:${port}/app/phones/a/stream?ticket=${ticket}&quality=saver`,
    { headers: { Origin: origin, Cookie: "session=synthetic" } });
  try {
    const message = once(browser, "message");
    await once(browser, "open");
    assert.deepEqual([...(await message)[0]], [1, 2, 3]);
    browser.send('{"type":"key","key":"home"}');
    assert.equal(await received.promise, '{"type":"key","key":"home"}');
    browser.close(); await released.promise;
    const replay = new WS(`ws://127.0.0.1:${port}/app/phones/a/stream?ticket=${ticket}`, { headers: { Origin: origin, Cookie: "session=synthetic" } });
    const error = await once(replay, "error"); assert.match(String(error[0]), /403/);
  } finally {
    browser.terminate(); for (const client of upstreams.clients) client.terminate();
    upstreams.close();
    await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => upstreamHttp.close(() => r()))]);
  }
});
