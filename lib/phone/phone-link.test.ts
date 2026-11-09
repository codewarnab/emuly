import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createEmulyLinks } from "./phone-link.ts";

const phone = { userId: 1, id: "phone-aaaa", codespaceName: "owned-space" };

test("Apps transports binary chunks unchanged through forwarding and bridge, preserving conflicts without replay", async () => {
  for (const forwarded of [true, false]) {
    let mutations = 0;
    const payload = Buffer.alloc(4 * 1024 * 1024, 0xa5);
    const server = createServer(async (req, res) => {
      mutations++;
      assert.equal(req.headers["x-github-token"], undefined);
      assert.equal(req.headers["x-upload-offset"], "4194304");
      const chunks: Buffer[] = [];
      for await (const bytes of req) chunks.push(bytes);
      assert.deepEqual(Buffer.concat(chunks), payload);
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ errorCode: "offset_conflict" }));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address() as { port: number };
    const links = createEmulyLinks({ token: async () => "synthetic-credential",
      tunnel: async () => ({ url: `http://127.0.0.1:${address.port}`, close() {} }),
      fetch: async (url, init) => {
        if (String(url).startsWith("https://")) {
          if (String(url).endsWith("/health")) return forwarded ? Response.json({ ok: true }) : new Response(null, { status: 403 });
          assert.equal(new Headers(init?.headers).get("x-github-token"), "synthetic-credential");
          assert.equal(init?.redirect, "manual");
          assert.deepEqual(init?.body, payload);
          mutations++;
          return Response.json({ errorCode: "offset_conflict" }, { status: 409 });
        }
        return fetch(url, init);
      } });
    try {
      const response = await links.apps(phone, "/app-installs/11111111-1111-1111-1111-111111111111/content", { method: "PUT", bytes: payload, offset: payload.length, digest: "a".repeat(64) });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).errorCode, "offset_conflict");
      assert.equal(mutations, 1);
    } finally { links.close(phone); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});

test("private forwarding keeps tokens server-side, refuses redirects, and falls back to one reusable bridge", async () => {
  let opens = 0, closes = 0, probes = 0, requests = 0;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.headers["x-github-token"], undefined, "the local bridge needs no GitHub credential");
    res.setHeader("Content-Type", "application/json");
    res.end('{"ok":true}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const links = createEmulyLinks({ token: async () => "synthetic-token",
    tunnel: async () => { opens++; return { url: `http://127.0.0.1:${address.port}`, close: () => { closes++; } }; },
    fetch: async (url, init) => {
      if (String(url).startsWith("https://")) {
        probes++;
        assert.equal(url, "https://owned-space-8790.app.github.dev/health");
        assert.equal(init?.redirect, "manual");
        assert.equal(new Headers(init?.headers).get("X-Github-Token"), "synthetic-token");
        return new Response(null, { status: 302, headers: { location: "https://login.invalid" } });
      }
      return fetch(url, init);
    } });
  try {
    await Promise.all([links.request(phone, "/health"), links.request(phone, "/health")]);
    await links.request(phone, "/tap", { x: 1, y: 2 });
    assert.equal(probes, 1);
    assert.equal(opens, 1);
    assert.equal(requests, 3);
    links.close(phone);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closes, 1);
  } finally { links.close(phone); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("forwarded connections refresh credentials, isolate owners, and never replay failed input", async () => {
  let credential = "first", calls = 0, owner = 1;
  const links = createEmulyLinks({ token: async user => `${credential}-${user}`,
    tunnel: async () => { throw new Error("No fallback after a successful probe"); },
    fetch: async (url, init) => {
      calls++;
      assert.equal(new Headers(init?.headers).get("X-Github-Token"), `${credential}-${owner}`);
      if (String(url).endsWith("/tap")) throw new Error("transport lost after delivery");
      return Response.json({ ok: true });
    } });
  try {
    await links.request(phone, "/health");
    credential = "refreshed";
    await assert.rejects(links.request(phone, "/tap", { x: 1, y: 2 }), /Phone connection failed/);
    assert.equal(calls, 3, "an uncertain POST is never sent twice");
    // A new owner must probe with their own token, even for the same identifiers.
    owner = 2;
    await links.request({ ...phone, userId: 2 }, "/health");
    assert.equal(calls, 5);
  } finally { links.close(phone); links.close({ ...phone, userId: 2 }); }
});

test("idle bridges close and reconnect, while active requests retain their connection", async () => {
  let opens = 0, closes = 0;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const links = createEmulyLinks({ token: async () => "synthetic", idleMs: 20,
    tunnel: async () => { opens++; return { url: "http://bridge.invalid", close: () => { closes++; } }; },
    fetch: async url => {
      if (String(url).startsWith("https://")) return new Response(null, { status: 403 });
      entered.resolve();
      await release.promise;
      return Response.json({ ok: true });
    } });
  try {
    const pending = links.request(phone, "/health");
    await entered.promise;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(closes, 0);
    release.resolve();
    await pending;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(closes, 1);
    await links.request(phone, "/health");
    assert.equal(opens, 2);
  } finally { release.resolve(); links.close(phone); }
});

test("closing a phone cancels a pending connection and disposes a bridge that opens late", async () => {
  const entered = Promise.withResolvers<void>();
  const bridge = Promise.withResolvers<{ url: string; close: () => void }>();
  let closes = 0;
  const links = createEmulyLinks({ token: async () => "synthetic",
    fetch: async () => new Response(null, { status: 403 }),
    tunnel: async (_token, _name, signal) => {
      entered.resolve();
      const result = await bridge.promise;
      assert.equal(signal.aborted, true);
      return result;
    } });
  const pending = links.request(phone, "/health");
  await entered.promise;
  links.close(phone);
  await assert.rejects(pending, /Phone connection failed/);
  bridge.resolve({ url: "http://late.invalid", close: () => { closes++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1);
});

test("a late failure from a closed connection cannot close its replacement", async () => {
  const entered = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<Response>();
  let opens = 0, closes = 0;
  const links = createEmulyLinks({ token: async () => "synthetic",
    tunnel: async () => ({ url: `http://bridge-${++opens}.invalid`, close: () => { closes++; } }),
    fetch: async url => {
      if (String(url).startsWith("https://")) return new Response(null, { status: 403 });
      if (String(url).includes("bridge-1")) { entered.resolve(); return failed.promise; }
      return Response.json({ ok: true });
    } });
  const old = links.request(phone, "/health");
  await entered.promise;
  links.close(phone);
  await links.request(phone, "/health");
  failed.reject(new Error("old transport closed"));
  await assert.rejects(old, /Phone connection failed/);
  await links.request(phone, "/health");
  assert.equal(opens, 2);
  assert.equal(closes, 1);
  links.close(phone);
});

test("a stream holds its Phase 0 lease until release and closes when the phone closes", async () => {
  let closes = 0;
  const links = createEmulyLinks({ token: async () => "synthetic", idleMs: 15,
    fetch: async () => new Response(null, { status: 403 }),
    tunnel: async () => ({ url: "http://127.0.0.1:10001", close: () => { closes++; } }) });
  try {
    const stream = await links.stream(phone);
    assert.equal(stream.url, "ws://127.0.0.1:10001/stream");
    assert.deepEqual(stream.headers, {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(closes, 0);
    stream.release(); stream.release();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(closes, 1); assert.equal(stream.signal.aborted, true);
    const next = await links.stream(phone);
    links.close(phone); assert.equal(next.signal.aborted, true); next.release();
  } finally { links.close(phone); }
});

test("a rejected private WebSocket switches the next connection to the persistent bridge", async () => {
  let tunnels = 0, token = "first";
  const links = createEmulyLinks({ token: async () => token,
    fetch: async () => Response.json({ ok: true }),
    tunnel: async () => { tunnels++; return { url: "http://127.0.0.1:10002", close() {} }; } });
  try {
    const first = await links.stream(phone);
    assert.equal(first.url, "wss://owned-space-8790.app.github.dev/stream");
    assert.deepEqual(first.headers, { "X-Github-Token": "first" });
    first.release(); token = "refreshed";
    const second = await links.stream(phone);
    assert.deepEqual(second.headers, { "X-Github-Token": "refreshed" });
    second.failed(); second.release();
    assert.equal(second.signal.aborted, true);
    const fallback = await links.stream(phone);
    assert.equal(fallback.url, "ws://127.0.0.1:10002/stream");
    assert.deepEqual(fallback.headers, {}); assert.equal(tunnels, 1); fallback.release();
  } finally { links.close(phone); }
});
