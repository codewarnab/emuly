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

test("a late viewer gets the stored config first, then no delta frames until a keyframe", async () => {
  const { hub, sessions } = setup();
  const first = new FakeSocket();
  hub.attach(first, "auto"); await flush();
  const session = sessions[0]!;
  session.video(CONFIG, 1); session.video(KEY, 2); session.video(DELTA, 3);
  assert.deepEqual(first.ids(), [1, 2, 3]);

  const late = new FakeSocket();
  hub.attach(late, "auto"); await flush();
  assert.equal(sessions.length, 1, "the late viewer joins the running session");
  assert.deepEqual(late.ids(), [1], "config packet first");
  assert.equal(session.resets(), 1, "the join asks for a fresh keyframe");
  session.video(DELTA, 4); session.video(KEY, 5); session.video(DELTA, 6);
  assert.deepEqual(late.ids(), [1, 5, 6]);
  assert.deepEqual(first.ids(), [1, 2, 3, 4, 5, 6]);
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
  assert.deepEqual(late.ids(), [1, 2], "video config, then audio config");
  session.video(AUDIO, 5);
  assert.deepEqual(late.ids(), [1, 2, 5], "audio does not wait for a keyframe");

  listener.bufferedAmount = 2 * 1024 * 1024;
  session.video(AUDIO, 6);
  assert.deepEqual(listener.ids(), [1, 2, 3, 4, 5], "a slow viewer skips audio");
  hub.closeAll();
});
