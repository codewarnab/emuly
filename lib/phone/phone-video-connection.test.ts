import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createPhoneVideoConnection, type VideoConnectionState } from "../../components/phone/phone-video-connection.ts";

function browser(t: TestContext, supported = true) {
  const cleanups: (() => void)[] = [], sessions: ReturnType<typeof createPhoneVideoConnection>[] = [];
  t.after(() => { for (const session of sessions) session.dispose(); for (const cleanup of cleanups) cleanup(); });
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1000 });
  t.mock.method(performance, "now", () => Date.now());
  const document = Object.assign(new EventTarget(), { hidden: false });
  const window = new EventTarget();
  const sockets: Socket[] = [], decoders: Decoder[] = [];
  const requests: { url: string; signal?: AbortSignal | null }[] = [];
  const animations = new Map<number, FrameRequestCallback>();
  let animation = 0;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    binaryType = "";
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    messages: string[] = [];
    url: URL;
    constructor(url: URL) { this.url = url; sockets.push(this); }
    send(message: string) { this.messages.push(message); }
    close(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  }
  class Decoder {
    state = "unconfigured";
    decodeQueueSize = 0;
    automatic = true;
    callbacks: { output: (frame: VideoFrame) => void; error: () => void };
    constructor(callbacks: Decoder["callbacks"]) { this.callbacks = callbacks; decoders.push(this); }
    static async isConfigSupported() { return { supported: true }; }
    configure() { this.state = "configured"; }
    decoded: number[] = [];
    decode(chunk: { timestamp: number }) { this.decoded.push(chunk.timestamp); if (this.automatic) this.output(chunk.timestamp); }
    output(timestamp: number) {
      let closed = false;
      this.callbacks.output({ timestamp, close: () => { closed = true; } } as VideoFrame);
      assert.equal(closed, true, "every decoder output releases its frame");
    }
    close() { this.state = "closed"; }
  }
  function replace(name: string, value: unknown) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    cleanups.push(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  if (supported) Object.assign(window, { VideoDecoder: Decoder });
  replace("window", window); replace("document", document);
  replace("location", new URL("https://phone.invalid/app"));
  replace("WebSocket", Socket); replace("VideoDecoder", Decoder);
  replace("EncodedVideoChunk", class { timestamp: number; constructor(chunk: { timestamp: number }) { this.timestamp = chunk.timestamp; } });
  replace("requestAnimationFrame", (callback: FrameRequestCallback) => { animations.set(++animation, callback); return animation; });
  replace("cancelAnimationFrame", (id: number) => animations.delete(id));
  let ticket: () => Promise<unknown> = async () => ({ ticket: "synthetic", attemptId: "attempt" });
  let failure: { status: number; body: unknown } | undefined;
  replace("fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, signal: init.signal });
    if (failure) {
      const current = failure;
      return { ok: false, status: current.status, json: async () => current.body };
    }
    return { ok: true, json: ticket };
  });
  const states: VideoConnectionState[] = [];
  let frames = 0, saver = 0;
  const start = () => {
    const connection = createPhoneVideoConnection({ id: "phone/a", quality: "auto",
      onState: state => states.push(state), onFrame: () => { frames++; return true; },
      onStats: () => {}, onSaver: () => { saver++; } });
    sessions.push(connection);
    return connection;
  };
  function packet(socket: Socket, flags: number, pts = 100, sent = Date.now()) {
    const bytes = new ArrayBuffer(29), view = new DataView(bytes);
    view.setUint8(0, flags); view.setBigUint64(1, BigInt(pts)); view.setFloat64(9, sent);
    new Uint8Array(bytes, 17).set([0, 0, 0, 1, 0x67, 0x42, 0x80, 0x1f, 0, 0, 1, 0x68]);
    socket.onmessage?.({ data: bytes });
  }
  return { start, states, sockets, decoders, requests, document, window, animations, packet,
    frames: () => frames, saver: () => saver, ticket: (next: typeof ticket) => { ticket = next; },
    fail: (status: number, body: unknown) => { failure = { status, body }; } };
}

test("live sessions decode, send controls, retry, and reject callbacks from the previous attempt", async t => {
  const b = browser(t), session = b.start();
  await setImmediate();
  const first = b.sockets[0], staleMessage = first.onmessage!, staleError = b.decoders[0].callbacks.error;
  assert.equal(session.send({ type: "key" }), false);
  b.packet(first, 2); b.packet(first, 1);
  assert.equal(b.frames(), 1);
  assert.equal(b.states.at(-1), "streaming");
  assert.equal(session.send({ type: "key", key: "home" }), true);
  assert.deepEqual(JSON.parse(first.messages.at(-1)!), { type: "key", key: "home" });
  first.close();
  assert.equal(b.decoders[0].state, "closed");
  assert.equal(b.animations.size, 0);
  assert.equal(b.states.at(-1), "retrying");
  t.mock.timers.tick(999); await setImmediate(); assert.equal(b.sockets.length, 1);
  t.mock.timers.tick(1); await setImmediate(); assert.equal(b.sockets.length, 2);
  b.packet(b.sockets[1], 2); b.decoders[1].automatic = false; b.packet(b.sockets[1], 1);
  staleError(); staleMessage({ data: "invalid" }); b.decoders[0].output(100);
  assert.equal(b.sockets[1].readyState, 1);
  assert.equal(b.frames(), 1);
  b.decoders[1].output(100); assert.equal(b.frames(), 2);
  session.dispose(); session.dispose();
  const requests = b.requests.length;
  b.window.dispatchEvent(new Event("focus")); t.mock.timers.tick(120000); await setImmediate();
  assert.equal(b.requests.length, requests);
  assert.equal(b.states.at(-1), "disposed");
  assert.equal(b.sockets[1].readyState, 3);
  assert.equal(session.send({ type: "key" }), false);
});

test("close code 4001 stops without scheduling a retry", async t => {
  const b = browser(t), session = b.start(); await setImmediate();
  const ws = b.sockets[0];
  ws.close(4001);
  await setImmediate();
  assert.equal(b.states.at(-1), "stopped");
  const sockets = b.sockets.length;
  t.mock.timers.tick(60000); await setImmediate();
  assert.equal(b.sockets.length, sockets, "a stopped phone is not retried");
  assert.equal(b.states.at(-1), "stopped");
  session.dispose();
});

test("a phone_stopped ticket response stops without retrying", async t => {
  const b = browser(t);
  b.fail(409, { errorCode: "phone_stopped" });
  const session = b.start(); await setImmediate();
  assert.equal(b.states.at(-1), "stopped");
  assert.equal(b.sockets.length, 0);
  const requests = b.requests.length;
  t.mock.timers.tick(60000); await setImmediate();
  assert.equal(b.requests.length, requests, "a stopped phone is not retried");
  assert.equal(b.states.at(-1), "stopped");
  session.dispose();
});

test("visibility keeps brief switches alive and suspends longer hidden sessions", async t => {
  const b = browser(t), session = b.start(); await setImmediate();
  const ws = b.sockets[0]; b.packet(ws, 2); b.packet(ws, 1);
  b.window.dispatchEvent(new Event("focus"));
  t.mock.timers.tick(10000); await setImmediate(); assert.equal(b.sockets.length, 1, "focus on a healthy stream keeps it");
  b.document.hidden = true; b.document.dispatchEvent(new Event("visibilitychange"));
  // The server answers each heartbeat, so the watchdog keeps the socket open.
  for (let waited = 0; waited < 59999; waited += 4999) {
    t.mock.timers.tick(Math.min(4999, 59999 - waited));
    ws.onmessage?.({ data: JSON.stringify({ type: "pong", server: Date.now(), time: Date.now() }) });
  }
  assert.equal(ws.readyState, 1);
  b.document.hidden = false; b.document.dispatchEvent(new Event("visibilitychange"));
  t.mock.timers.tick(1); b.packet(ws, 1, 101);
  t.mock.timers.tick(5000); await setImmediate(); assert.equal(b.sockets.length, 1);
  b.document.hidden = true; b.document.dispatchEvent(new Event("visibilitychange"));
  t.mock.timers.tick(60000); assert.equal(ws.readyState, 3);
  t.mock.timers.tick(5000); await setImmediate(); assert.equal(b.sockets.length, 1);
  b.document.hidden = false; b.window.dispatchEvent(new Event("focus")); await setImmediate();
  assert.equal(b.sockets.length, 2);
  session.dispose();
});

test("a slow socket open gets 20 s, then 15 s for the first frame", async t => {
  const b = browser(t), session = b.start(); await setImmediate();
  const ws = b.sockets[0];
  t.mock.timers.tick(15000); await setImmediate();
  assert.notEqual(ws.readyState, 3, "a socket that is still opening is not closed after 6 s");
  ws.onopen?.();
  t.mock.timers.tick(14000); await setImmediate();
  assert.notEqual(ws.readyState, 3);
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(ws.readyState, 3, "no frame 15 s after open closes the socket");
  session.dispose();
});

test("a socket that never opens is retried after 20 s", async t => {
  const b = browser(t), session = b.start(); await setImmediate();
  const ws = b.sockets[0];
  t.mock.timers.tick(19999); await setImmediate();
  assert.notEqual(ws.readyState, 3);
  t.mock.timers.tick(1); await setImmediate();
  assert.equal(ws.readyState, 3);
  session.dispose();
});

test("pongs do not hide a socket without a painted frame", async t => {
  const b = browser(t), session = b.start(); await setImmediate();
  const ws = b.sockets[0];
  ws.onopen?.();
  for (let waited = 0; waited < 15000; waited += 1000) {
    ws.onmessage?.({ data: JSON.stringify({ type: "pong", server: Date.now(), time: Date.now() }) });
    t.mock.timers.tick(1000);
  }
  await setImmediate();
  assert.equal(ws.readyState, 3);
  assert.equal(b.states.at(-1), "retrying");
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(b.sockets.length, 2);
  session.dispose();
});

test("resume reconnects a static screen; the decoder skips to a keyframe once, then asks for saver quality", async t => {
  const b = browser(t); b.start(); await setImmediate();
  b.window.dispatchEvent(new Event("focus"));
  t.mock.timers.tick(4999); await setImmediate(); assert.equal(b.sockets.length, 1);
  t.mock.timers.tick(1); await setImmediate();
  assert.equal(b.sockets.length, 2);
  const ws = b.sockets[1]; b.packet(ws, 2); b.decoders[1].decodeQueueSize = 6; b.packet(ws, 1);
  // First time behind: keep the socket, drop frames, and ask the runner for a keyframe.
  assert.equal(b.saver(), 0); assert.notEqual(ws.readyState, 3);
  assert.ok(ws.messages.includes('{"type":"keyframe"}'));
  // Behind again within 10 s: the device is too slow for this quality, so reconnect with saver.
  b.packet(ws, 1);
  assert.equal(b.saver(), 1); assert.equal(ws.readyState, 3);
});

for (const supported of [true, false]) test(`disposal ignores late ${supported ? "video" : "fallback"} tickets`, async t => {
  const b = browser(t, supported);
  let resolve!: (value: unknown) => void;
  b.ticket(() => new Promise(done => { resolve = done; }));
  const session = b.start(); await setImmediate(); session.dispose();
  assert.equal(b.requests[0].signal?.aborted, true);
  resolve({ ticket: "late", attemptId: "late" }); await setImmediate();
  assert.equal(b.sockets.length, 0);
  assert.deepEqual(b.states, supported ? ["suspended", "connecting", "disposed"] : ["fallback", "disposed"]);
});

test("ticket failures use bounded retry delays and disposal cancels the next retry", async t => {
  const b = browser(t);
  b.ticket(async () => { throw new Error("offline"); });
  const session = b.start(); await setImmediate();
  for (const delay of [1000, 2000, 5000, 5000]) {
    const before = b.requests.length;
    t.mock.timers.tick(delay - 1); await setImmediate(); assert.equal(b.requests.length, before);
    t.mock.timers.tick(1); await setImmediate(); assert.equal(b.requests.length, before + 1);
  }
  session.dispose(); const before = b.requests.length;
  t.mock.timers.tick(10000); await setImmediate(); assert.equal(b.requests.length, before);
});

test("malformed stream tickets retry without opening a socket", async t => {
  const b = browser(t);
  b.ticket(async () => ({ ticket: 123, attemptId: {} }));
  b.start(); await setImmediate();
  assert.equal(b.sockets.length, 0);
  assert.equal(b.states.at(-1), "retrying");
  b.ticket(async () => ({ ticket: "valid-without-diagnostics" }));
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(b.sockets.length, 1);
});

test("screenshot fallback reports presence without sockets and stops after disposal", async t => {
  const b = browser(t, false), session = b.start(); await setImmediate();
  assert.equal(b.sockets.length, 0); assert.equal(b.states.at(-1), "fallback");
  session.reportFallback();
  const before = b.requests.length;
  t.mock.timers.tick(30000); await setImmediate(); assert.ok(b.requests.length > before);
  session.dispose(); const after = b.requests.length;
  session.reportFallback(); b.document.dispatchEvent(new Event("visibilitychange"));
  t.mock.timers.tick(15 * 60000); await setImmediate();
  assert.equal(b.requests.length, after);
});

test("two decoder failures switch to the screenshot view instead of retrying for ever", async t => {
  const b = browser(t), session = b.start(); await setImmediate();
  b.decoders[0].callbacks.error();
  assert.equal(b.states.at(-1), "retrying");
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(b.sockets.length, 2);
  b.decoders[1].callbacks.error();
  assert.equal(b.states.at(-1), "fallback");
  t.mock.timers.tick(60000); await setImmediate();
  assert.equal(b.sockets.length, 2, "no new scrcpy stream after the fallback");
  session.dispose();
});

for (const status of [401, 403, 404]) test(`a ${status} ticket response stops without retrying`, async t => {
  const b = browser(t);
  b.fail(status, { error: "denied" });
  const session = b.start(); await setImmediate();
  assert.equal(b.states.at(-1), "stopped");
  t.mock.timers.tick(60000); await setImmediate();
  assert.equal(b.sockets.length, 0);
  assert.equal(b.requests.length, 1);
  session.dispose();
});

test("a tab switch keeps a live socket streaming, so input works at once", async t => {
  const b = browser(t), session = b.start(); await setImmediate();
  const ws = b.sockets[0];
  b.packet(ws, 2); b.packet(ws, 1);
  assert.equal(b.states.at(-1), "streaming");
  Object.defineProperty(b.document, "hidden", { configurable: true, value: true });
  b.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(b.states.at(-1), "suspended");
  Object.defineProperty(b.document, "hidden", { configurable: true, value: false });
  b.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(b.states.at(-1), "streaming");
  assert.equal(session.send({ type: "key", key: "home" }), true);
  t.mock.timers.tick(10000); await setImmediate();
  assert.equal(b.sockets.length, 1, "no reconnect for a static screen");
  session.dispose();
});

test("old frames are skipped up to a fresh keyframe, and video that stays old reconnects with saver", async t => {
  const b = browser(t); b.start(); await setImmediate();
  const ws = b.sockets[0];
  ws.onmessage?.({ data: JSON.stringify({ type: "pong", server: Date.now(), time: Date.now() }) });
  b.packet(ws, 2); b.packet(ws, 1, 100);
  // A 3 s old delta and a 3 s old keyframe: both dropped, and one keyframe request.
  b.packet(ws, 0, 101, Date.now() - 3000); b.packet(ws, 1, 102, Date.now() - 3000);
  assert.equal(ws.messages.filter(m => m === '{"type":"keyframe"}').length, 1);
  // A fresh delta still waits for a keyframe; a fresh keyframe decodes again.
  b.packet(ws, 0, 103); b.packet(ws, 1, 104);
  assert.deepEqual(b.decoders[0].decoded, [100, 104]);
  assert.equal(b.saver(), 0); assert.notEqual(ws.readyState, 3);
  // Old for more than 5 s: the network is slower than the video.
  b.packet(ws, 0, 105, Date.now() - 3000);
  t.mock.timers.tick(5001);
  b.packet(ws, 0, 106, Date.now() - 3000);
  assert.equal(b.saver(), 1); assert.equal(ws.readyState, 3);
});

function storage(t: TestContext) {
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); } } });
  t.after(() => { Reflect.deleteProperty(globalThis, "sessionStorage"); });
  return items;
}
const DIRECT = { url: "wss://phone-a-8791.app.github.dev", ticket: "part.sig" };

test("direct: a direct ticket opens the codespace port, and the quality goes to the ticket route", async t => {
  const b = browser(t); storage(t);
  b.ticket(async () => ({ ticket: "vercel", attemptId: "attempt", direct: DIRECT }));
  const session = b.start(); await setImmediate();
  assert.match(b.requests[0].url, /stream-ticket\?quality=auto$/);
  const ws = b.sockets[0];
  assert.equal(`${ws.url.origin}${ws.url.pathname}`, "wss://phone-a-8791.app.github.dev/stream");
  assert.equal(ws.url.searchParams.get("ticket"), "part.sig");
  ws.onopen?.(); b.packet(ws, 2); b.packet(ws, 1);
  assert.equal(b.states.at(-1), "streaming");
  session.dispose();
});

test("direct: a direct socket that does not open in 3 s falls back to Vercel at once, and stays there", async t => {
  const b = browser(t); const items = storage(t);
  b.ticket(async () => ({ ticket: "vercel", attemptId: "attempt", direct: DIRECT }));
  const session = b.start(); await setImmediate();
  t.mock.timers.tick(2999); await setImmediate();
  assert.equal(b.sockets.length, 1);
  t.mock.timers.tick(1); await setImmediate();
  assert.equal(b.sockets.length, 2, "the fallback starts within 3.5 s");
  assert.equal(b.sockets[1].url.host, "phone.invalid");
  assert.equal(b.sockets[1].url.searchParams.get("ticket"), "vercel");
  assert.equal(items.get("emuly-direct-failed:phone/a"), "1");
  // A later reconnect does not try direct again in this tab.
  b.sockets[1].close(); t.mock.timers.tick(60_000); await setImmediate();
  assert.equal(b.sockets.at(-1)!.url.host, "phone.invalid");
  session.dispose();
});

test("direct: a direct socket that closes before it opens falls back to Vercel with no retry delay", async t => {
  const b = browser(t); storage(t);
  b.ticket(async () => ({ ticket: "vercel", attemptId: "attempt", direct: DIRECT }));
  const session = b.start(); await setImmediate();
  b.sockets[0].close(1006); await setImmediate();
  assert.equal(b.sockets.length, 2);
  assert.equal(b.sockets[1].url.host, "phone.invalid");
  session.dispose();
});

test("direct: a direct socket that closes mid-stream reconnects to direct", async t => {
  const b = browser(t); const items = storage(t);
  b.ticket(async () => ({ ticket: "vercel", attemptId: "attempt", direct: DIRECT }));
  const session = b.start(); await setImmediate();
  const ws = b.sockets[0];
  ws.onopen?.(); b.packet(ws, 2); b.packet(ws, 1);
  ws.close(1006); t.mock.timers.tick(1000); await setImmediate();
  assert.equal(b.sockets.length, 2);
  assert.equal(b.sockets[1].url.host, "phone-a-8791.app.github.dev");
  assert.equal(items.size, 0);
  session.dispose();
});

test("direct: no direct ticket uses Vercel as before", async t => {
  const b = browser(t); storage(t);
  const session = b.start(); await setImmediate();
  assert.equal(b.sockets[0].url.host, "phone.invalid");
  session.dispose();
});
