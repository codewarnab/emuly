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
    decode(chunk: { timestamp: number }) { if (this.automatic) this.output(chunk.timestamp); }
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
  function packet(socket: Socket, flags: number, pts = 100) {
    const bytes = new ArrayBuffer(29), view = new DataView(bytes);
    view.setUint8(0, flags); view.setBigUint64(1, BigInt(pts)); view.setFloat64(9, Date.now());
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

test("a slow socket open gets 20 s, then 6 s for the first frame", async t => {
  const b = browser(t), session = b.start(); await setImmediate();
  const ws = b.sockets[0];
  t.mock.timers.tick(15000); await setImmediate();
  assert.notEqual(ws.readyState, 3, "a socket that is still opening is not closed after 6 s");
  ws.onopen?.();
  t.mock.timers.tick(5000); await setImmediate();
  assert.notEqual(ws.readyState, 3);
  t.mock.timers.tick(1000); await setImmediate();
  assert.equal(ws.readyState, 3, "no frame 6 s after open closes the socket");
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
  for (let waited = 0; waited < 6000; waited += 1000) {
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

test("resume reconnects a static screen and queue pressure requests saver quality", async t => {
  const b = browser(t); b.start(); await setImmediate();
  b.window.dispatchEvent(new Event("focus"));
  t.mock.timers.tick(4999); await setImmediate(); assert.equal(b.sockets.length, 1);
  t.mock.timers.tick(1); await setImmediate();
  assert.equal(b.sockets.length, 2);
  const ws = b.sockets[1]; b.packet(ws, 2); b.decoders[1].decodeQueueSize = 6; b.packet(ws, 1);
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
