import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHub } from "../../phone/runner/scrcpy-hub.mjs";

const CONFIG = 2, KEY = 1, DELTA = 0;
const packet = (flags: number, id: number) => Buffer.from([flags, id]);
const flush = () => new Promise(resolve => setImmediate(resolve));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class FakeSession extends EventEmitter {
  writes: Buffer[] = [];
  closed = false;
  writableLength = 0;
  start() {}
  write(bytes: Buffer) { if (!this.closed) this.writes.push(bytes); }
  close() { if (this.closed) return; this.closed = true; this.emit("close"); }
  video(flags: number, id: number) { this.emit("packet", packet(flags, id)); }
  resets() { return this.writes.filter(bytes => bytes.length === 1 && bytes[0] === 17).length; }
}

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: (Buffer | string)[] = [];
  send(data: Buffer | string) { this.sent.push(data); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
  ids() { return this.sent.filter(Buffer.isBuffer).map(data => data[1]); }
  input(message: object) { this.emit("message", Buffer.from(JSON.stringify(message)), false); }
}

function setup(options: { share?: boolean; lingerMs?: number; switchLingerMs?: number } = {}) {
  const sessions: FakeSession[] = [];
  const hub = createHub({ ...options, open: async () => { const session = new FakeSession(); sessions.push(session); return session; } });
  return { hub, sessions };
}

test("a late viewer gets the config, then a replay of the last keyframe and the frames after it", async () => {
  const { hub, sessions } = setup();
  const first = new FakeSocket();
  hub.attach(first, "auto"); await flush();
  const session = sessions[0]!;
  session.video(CONFIG, 1); session.video(DELTA, 9); session.video(KEY, 2); session.video(DELTA, 3);
  assert.deepEqual(first.ids(), [1, 2, 3]);

  const late = new FakeSocket();
  hub.attach(late, "auto"); await flush();
  assert.equal(sessions.length, 1, "the late viewer joins the running session");
  assert.deepEqual(late.sent.filter(data => typeof data === "string").map(data => JSON.parse(data as string)), [{ type: "replay", frames: 2 }]);
  assert.deepEqual(late.ids(), [1, 2, 3], "config, then the keyframe and the delta after it");
  assert.equal(session.resets(), 0, "a replay needs no fresh keyframe");
  session.video(DELTA, 4);
  assert.deepEqual(late.ids(), [1, 2, 3, 4], "live frames continue after the replay");
  hub.closeAll();
});

test("with no saved keyframe, a late viewer gets the config, then no delta frames until a keyframe", async () => {
  const { hub, sessions } = setup();
  hub.attach(new FakeSocket(), "auto"); await flush();
  const session = sessions[0]!;
  session.video(CONFIG, 1); session.video(DELTA, 2);
  const late = new FakeSocket();
  hub.attach(late, "auto"); await flush();
  assert.deepEqual(late.ids(), [1]);
  assert.equal(session.resets(), 1, "the join asks for a fresh keyframe");
  session.video(DELTA, 3); session.video(KEY, 4);
  assert.deepEqual(late.ids(), [1, 4]);
  hub.closeAll();
});

test("a replay that grows too big starts again from a fresh keyframe", async () => {
  const { hub, sessions } = setup();
  hub.attach(new FakeSocket(), "auto"); await flush();
  const session = sessions[0]!;
  session.video(CONFIG, 1); session.video(KEY, 2);
  for (let i = 0; i < 95; i++) session.video(DELTA, 3);
  assert.equal(session.resets(), 1);
  const late = new FakeSocket();
  hub.attach(late, "auto"); await flush();
  assert.deepEqual(late.ids(), [1], "no partial replay");
  hub.closeAll();
});

// Flow control needs real packet headers: flags, pts (8 bytes), send time (8 bytes).
const framed = (flags: number, pts: number) => { const bytes = Buffer.alloc(17); bytes[0] = flags; bytes.writeBigUInt64BE(BigInt(pts), 1); return bytes; };
const ptsOf = (socket: FakeSocket) => socket.sent.filter(Buffer.isBuffer).filter(data => !(data[0] & CONFIG)).map(data => Number(data.readBigUInt64BE(1)));

test("flow control: a viewer that acks gets frames held while it lags, then a fresh keyframe", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const sessions: FakeSession[] = [];
  const hub = createHub({ now: Date.now, open: async () => { const session = new FakeSession(); sessions.push(session); return session; } });
  const viewer = new FakeSocket();
  hub.attach(viewer, "auto"); await flush();
  const session = sessions[0]!;
  const send = (flags: number, pts: number) => session.emit("packet", framed(flags, pts));
  send(CONFIG, 0); send(KEY, 1);
  viewer.input({ type: "ack", pts: 1 });
  send(DELTA, 2);
  t.mock.timers.tick(600);
  send(DELTA, 3);
  assert.deepEqual(ptsOf(viewer), [1, 2], "frame 2 is unacked for 600 ms, so frame 3 is held");
  viewer.input({ type: "ack", pts: 2 });
  assert.equal(session.resets(), 1, "the window opened again, so the hub asks for a keyframe");
  send(DELTA, 4); send(KEY, 5); send(DELTA, 6);
  assert.deepEqual(ptsOf(viewer), [1, 2, 5, 6], "deltas wait for the fresh keyframe");
  hub.closeAll();
});

test("flow control: a viewer that never acks keeps the old behaviour", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const sessions: FakeSession[] = [];
  const hub = createHub({ now: Date.now, open: async () => { const session = new FakeSession(); sessions.push(session); return session; } });
  const viewer = new FakeSocket();
  hub.attach(viewer, "auto"); await flush();
  const session = sessions[0]!;
  session.emit("packet", framed(CONFIG, 0)); session.emit("packet", framed(KEY, 1));
  t.mock.timers.tick(20_000);
  session.emit("packet", framed(DELTA, 2));
  assert.deepEqual(ptsOf(viewer), [1, 2]);
  assert.equal(viewer.readyState, 1);
  hub.closeAll();
});

test("flow control: acks do not count toward the input rate limit", async () => {
  const { hub, sessions } = setup();
  const viewer = new FakeSocket();
  hub.attach(viewer, "auto"); await flush();
  sessions[0]!.video(CONFIG, 1);
  for (let pts = 0; pts < 400; pts++) viewer.input({ type: "ack", pts });
  assert.equal(viewer.readyState, 1);
  hub.closeAll();
});

test("viewers that join at the same time share one start and one reset", async () => {
  const { hub, sessions } = setup();
  const first = new FakeSocket();
  hub.attach(first, "auto"); await flush();
  sessions[0]!.video(CONFIG, 1);
  for (let i = 0; i < 3; i++) hub.attach(new FakeSocket(), "auto");
  await flush();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.resets(), 1);
  hub.closeAll();
});

test("a slow viewer skips frames or is closed alone, and others keep the stream", async () => {
  const { hub, sessions } = setup();
  const fast = new FakeSocket(), slow = new FakeSocket();
  hub.attach(fast, "auto"); hub.attach(slow, "auto"); await flush();
  const session = sessions[0]!;
  session.video(CONFIG, 1); session.video(KEY, 2);
  slow.bufferedAmount = 2 * 1024 * 1024;
  session.video(DELTA, 3);
  slow.bufferedAmount = 0;
  session.video(DELTA, 4);
  assert.deepEqual(slow.ids(), [1, 2], "after a skip the slow viewer waits for a keyframe");
  slow.bufferedAmount = 5 * 1024 * 1024;
  session.video(KEY, 5);
  assert.equal(slow.readyState, 3);
  assert.equal(session.closed, false);
  assert.deepEqual(fast.ids(), [1, 2, 3, 4, 5]);
  hub.closeAll();
});

test("a session waits for a reload, and ends after the linger time", async () => {
  const { hub, sessions } = setup({ lingerMs: 30 });
  const first = new FakeSocket();
  hub.attach(first, "auto"); await flush();
  first.close();
  await wait(10);
  hub.attach(new FakeSocket(), "auto"); await flush();
  assert.equal(sessions.length, 1, "the reload reuses the session");
  hub.closeAll();

  const again = setup({ lingerMs: 20 });
  const viewer = new FakeSocket();
  again.hub.attach(viewer, "auto"); await flush();
  viewer.close();
  await wait(50);
  assert.equal(again.sessions[0]!.closed, true);
  assert.equal(again.hub.sessions(), 0);
});

test("a quality change stops the old idle session sooner", async () => {
  const { hub, sessions } = setup({ lingerMs: 10_000, switchLingerMs: 20 });
  const viewer = new FakeSocket();
  hub.attach(viewer, "auto"); await flush();
  viewer.close();
  hub.attach(new FakeSocket(), "saver"); await flush();
  await wait(50);
  assert.equal(sessions[0]!.closed, true);
  assert.equal(sessions[1]!.closed, false);
  hub.closeAll();
});

test("when the session dies all its viewers close, and closeAll ends lingering sessions", async () => {
  const { hub, sessions } = setup();
  const a = new FakeSocket(), b = new FakeSocket();
  hub.attach(a, "auto"); hub.attach(b, "auto"); await flush();
  sessions[0]!.close();
  assert.equal(a.readyState, 3); assert.equal(b.readyState, 3);

  const c = new FakeSocket();
  hub.attach(c, "auto"); await flush();
  c.close();
  assert.equal(hub.sessions(), 1, "lingering");
  hub.closeAll();
  assert.equal(hub.sessions(), 0);
  assert.equal(sessions[1]!.closed, true);
});

test("viewers use separate pointer IDs, and a leaving viewer releases only its own touches", async () => {
  const { hub, sessions } = setup();
  const a = new FakeSocket(), b = new FakeSocket();
  hub.attach(a, "auto"); hub.attach(b, "auto"); await flush();
  const session = sessions[0]!;
  const touch = { type: "touch", action: "down", pointer: 0, x: 1, y: 1, width: 10, height: 10 };
  a.input(touch); b.input(touch);
  const pointers = session.writes.filter(bytes => bytes[0] === 2).map(bytes => bytes.readBigUInt64BE(2)).map(Number);
  assert.deepEqual(pointers, [0, 32]);
  session.writes = [];
  b.close();
  const cancels = session.writes.filter(bytes => bytes[0] === 2);
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0]![1], 3, "cancel");
  assert.equal(Number(cancels[0]!.readBigUInt64BE(2)), 32);
  hub.closeAll();
});

test("a clipboard reply goes only to the viewer that asked", async () => {
  const { hub, sessions } = setup();
  const a = new FakeSocket(), b = new FakeSocket();
  hub.attach(a, "auto"); hub.attach(b, "auto"); await flush();
  b.input({ type: "get-clipboard" });
  sessions[0]!.emit("device", { type: "clipboard", text: "hello" });
  const texts = (socket: FakeSocket) => socket.sent.filter(data => typeof data === "string");
  assert.deepEqual(texts(a), []);
  assert.deepEqual(texts(b).map(text => JSON.parse(text as string)), [{ type: "clipboard", text: "hello" }]);
  sessions[0]!.emit("device", { type: "clipboard", text: "unasked" });
  assert.equal(texts(b).length, 1);
  hub.closeAll();
});

test("share=false gives each viewer its own session that ends with it", async () => {
  const { hub, sessions } = setup({ share: false });
  const a = new FakeSocket(), b = new FakeSocket();
  hub.attach(a, "auto"); hub.attach(b, "auto"); await flush();
  assert.equal(sessions.length, 2);
  a.close();
  assert.equal(sessions[0]!.closed, true);
  assert.equal(sessions[1]!.closed, false);
  hub.closeAll();
});

test("a failed start closes the waiting viewers", async () => {
  const hub = createHub({ open: async () => { throw new Error("scrcpy timeout"); } });
  const viewer = new FakeSocket();
  hub.attach(viewer, "auto"); await flush(); await flush();
  assert.equal(viewer.readyState, 3);
  assert.equal(hub.sessions(), 0);
});

test("audio goes only to viewers that ask for it, and a late one gets the audio config first", async () => {
  const AUDIO = 4;
  const { hub, sessions } = setup();
  const silent = new FakeSocket(), listener = new FakeSocket();
  hub.attach(silent, "auto"); hub.attach(listener, "auto", { audio: true }); await flush();
  const session = sessions[0]!;
  session.video(CONFIG, 1); session.video(AUDIO | CONFIG, 2); session.video(KEY, 3); session.video(AUDIO, 4);
  assert.deepEqual(silent.ids(), [1, 3], "no audio for a viewer that did not ask");
  assert.deepEqual(listener.ids(), [1, 2, 3, 4]);

  const late = new FakeSocket();
  hub.attach(late, "auto", { audio: true }); await flush();
  assert.deepEqual(late.ids(), [1, 3, 2], "video config and the replayed keyframe, then audio config");
  session.video(AUDIO, 5);
  assert.deepEqual(late.ids(), [1, 3, 2, 5], "audio does not wait for a keyframe");

  listener.bufferedAmount = 2 * 1024 * 1024;
  session.video(AUDIO, 6);
  assert.deepEqual(listener.ids(), [1, 2, 3, 4, 5], "a slow viewer skips audio");
  hub.closeAll();
});
