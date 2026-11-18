import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMp4Muxer, HEAD_SIZE, nalUnits, readPacket, spsSize } from "../../phone/runner/mp4-mux.mjs";
import { createRecorder } from "../../phone/runner/recording.mjs";
import { createHub } from "../../phone/runner/scrcpy-hub.mjs";

// Real SPS/PPS from x264: High 1080x2400 (2400 is not a multiple of 16, so it needs cropping)
// and Constrained Baseline 720x1280.
const HIGH = { sps: "67640032acb20088025bcbe022000003000200000300781e306490", pps: "68ebc3cb22c0" };
const BASE = { sps: "6742c01fd900b40a1b0110000003001000000303c0f1832480", pps: "68cb83cb20" };
const hex = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));
const annexB = (...units: Uint8Array[]) => Buffer.concat(units.flatMap(unit => [Buffer.from([0, 0, 0, 1]), Buffer.from(unit)]));
const config = (set: { sps: string; pps: string }) => annexB(hex(set.sps), hex(set.pps));
const slice = (key: boolean, size = 40) => Uint8Array.from({ length: size }, (_, i) => i ? (i % 7) + 1 : key ? 0x65 : 0x41);

/** Read the boxes the player uses: sizes, sync samples, durations, chunk offsets and sample entries. */
function parse(file: Uint8Array) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const type = (at: number) => String.fromCharCode(...file.subarray(at + 4, at + 8));
  const out: Record<string, number[]> & { mdat?: [number, number]; sizes?: [number, number][] } = {};
  const containers = new Set(["moov", "trak", "mdia", "minf", "stbl"]);
  function walk(start: number, end: number) {
    for (let at = start; at < end;) {
      let size = view.getUint32(at); const name = type(at); let header = 8;
      if (size === 1) { size = Number(view.getBigUint64(at + 8)); header = 16; }
      assert.ok(size >= 8 && at + size <= end, `box ${name} fits`);
      if (containers.has(name)) walk(at + 8, at + size);
      const body = at + header;
      const list = (from: number, step = 4) => Array.from({ length: view.getUint32(from) }, (_, i) => view.getUint32(from + 4 + i * step));
      if (name === "mdat") out.mdat = [body, size - header];
      if (name === "stsz") out.stsz = list(body + 8);
      if (name === "stss") out.stss = list(body + 4);
      if (name === "stts") out.stts = Array.from({ length: view.getUint32(body + 4) }, (_, i) => [view.getUint32(body + 8 + i * 8), view.getUint32(body + 12 + i * 8)]).flat();
      if (name === "stsc") out.stsc = Array.from({ length: view.getUint32(body + 4) * 3 }, (_, i) => view.getUint32(body + 8 + i * 4));
      if (name === "co64") out.co64 = Array.from({ length: view.getUint32(body + 4) }, (_, i) => Number(view.getBigUint64(body + 8 + i * 8)));
      if (name === "stsd") {
        out.sizes = [];
        for (let entry = body + 8, n = 0; n < view.getUint32(body + 4); n++, entry += view.getUint32(entry)) {
          out.sizes.push([view.getUint16(entry + 32), view.getUint16(entry + 34)]);
        }
      }
      at += size;
    }
  }
  walk(0, file.length);
  return out;
}

type Packet = { config: boolean; key?: boolean; pts: number; data: Uint8Array; at?: number };
function build(packets: Packet[], endAt: number) {
  const muxer = createMp4Muxer();
  const parts: Uint8Array[] = [new Uint8Array(HEAD_SIZE)];
  for (const packet of packets) { const sample = muxer.add(packet); if (sample) parts.push(sample); }
  const result = muxer.finish(endAt);
  parts[0] = result.head; parts.push(result.tail);
  return { file: new Uint8Array(Buffer.concat(parts)), result };
}

test("spsSize reads cropped and plain sizes", () => {
  assert.deepEqual(spsSize(hex(HIGH.sps)), { width: 1080, height: 2400 });
  assert.deepEqual(spsSize(hex(BASE.sps)), { width: 720, height: 1280 });
});

test("nalUnits splits 3- and 4-byte start codes without copying", () => {
  const bytes = Uint8Array.from([0, 0, 0, 1, 0x67, 1, 0, 0, 1, 0x68, 2, 0, 0, 0, 1, 0x65, 3, 4]);
  assert.deepEqual(nalUnits(bytes).map(unit => Array.from(unit)), [[0x67, 1], [0x68, 2], [0x65, 3, 4]]);
  assert.equal(nalUnits(bytes)[0]!.buffer, bytes.buffer);
});

test("frames become length-prefixed samples with correct tables", () => {
  const packets = [
    { config: false, key: false, pts: 0, data: annexB(slice(false)), at: 0 },     // before any config: dropped
    { config: true, key: false, pts: 0, data: config(HIGH), at: 0 },
    { config: false, key: false, pts: 0, data: annexB(slice(false)), at: 0 },     // before the keyframe: dropped
    { config: false, key: true, pts: 1_000_000, data: annexB(hex("09f0"), slice(true)), at: 1000 },
    { config: false, key: false, pts: 1_033_333, data: annexB(slice(false, 30)), at: 1033 },
    { config: false, key: false, pts: 1_066_666, data: annexB(slice(false, 20)), at: 1066 },
    { config: false, key: true, pts: 1_566_666, data: annexB(slice(true, 10)), at: 1566 },
  ];
  const { file, result } = build(packets, 2566);
  const boxes = parse(file);
  assert.deepEqual(boxes.stsz, [44, 34, 24, 14]);              // 4-byte length + NAL; the AUD is removed
  assert.deepEqual(boxes.stss, [1, 4]);
  assert.deepEqual(boxes.stts, [2, 33_333, 1, 500_000, 1, 1_000_000]); // last frame stays until stop
  assert.deepEqual(boxes.sizes, [[1080, 2400]]);
  assert.deepEqual(boxes.co64, [HEAD_SIZE]);
  assert.deepEqual(boxes.mdat, [16 + 32, 116]);
  assert.equal(result.frames, 4);
  assert.equal(result.durationMs, 1567);
  assert.equal(result.bytes, file.length);
  assert.deepEqual(Array.from(file.subarray(HEAD_SIZE, HEAD_SIZE + 5)), [0, 0, 0, 40, 0x65]);
});

test("a size change (rotation) adds a sample entry and a new chunk", () => {
  const frame = (key: boolean, pts: number) => ({ config: false, key, pts, data: annexB(slice(key)), at: pts / 1000 });
  const packets = [
    { config: true, key: false, pts: 0, data: config(BASE), at: 0 }, frame(true, 0), frame(false, 33_333),
    { config: true, key: false, pts: 0, data: config(HIGH), at: 66 }, frame(true, 66_666),
    { config: true, key: false, pts: 0, data: config(BASE), at: 99 }, frame(true, 99_999), // same as the first: no new entry
  ];
  const boxes = parse(build(packets, 200).file);
  assert.deepEqual(boxes.sizes, [[720, 1280], [1080, 2400]]);
  assert.deepEqual(boxes.stsc, [1, 2, 1, 2, 1, 2, 3, 1, 1]);
  assert.deepEqual(boxes.co64, [HEAD_SIZE, HEAD_SIZE + 88, HEAD_SIZE + 132]);
});

test("a pts jump after an encoder restart uses arrival time", () => {
  const packets = [
    { config: true, key: false, pts: 0, data: config(BASE), at: 0 },
    { config: false, key: true, pts: 5_000_000, data: annexB(slice(true)), at: 100 },
    { config: false, key: true, pts: 0, data: annexB(slice(true)), at: 350 },
  ];
  assert.deepEqual(parse(build(packets, 400).file).stts, [1, 250_000, 1, 50_000]);
});

test("finish without frames fails", () => {
  const muxer = createMp4Muxer();
  muxer.add({ config: true, key: false, pts: 0, data: config(BASE), at: 0 });
  assert.throws(() => muxer.finish(), /No video frames/);
});

test("readPacket reads the runner's 17-byte header", () => {
  const packet = Buffer.alloc(19);
  packet[0] = 3; packet.writeBigUInt64BE(BigInt(123_456), 1); packet.writeDoubleBE(99, 9); packet[17] = 7; packet[18] = 8;
  const read = readPacket(packet, 5);
  assert.deepEqual({ ...read, data: Array.from(read.data) }, { config: true, key: true, pts: 123_456, data: [7, 8], at: 5 });
});

// ---- runner recorder through the real hub ----

class FakeSession extends EventEmitter {
  writes: Buffer[] = [];
  closed = false;
  writableLength = 0;
  start() {}
  write(bytes: Buffer) { if (!this.closed) this.writes.push(bytes); }
  close() { if (this.closed) return; this.closed = true; this.emit("close"); }
  video(flags: number, pts: number, data: Uint8Array) {
    const header = Buffer.alloc(17); header[0] = flags; header.writeBigUInt64BE(BigInt(pts), 1);
    this.emit("packet", Buffer.concat([header, Buffer.from(data)]));
  }
}
const flush = () => new Promise(resolve => setImmediate(resolve));

async function recorderFixture(maxBytes?: number) {
  const dir = await mkdtemp(join(tmpdir(), "emuly-recording-test-"));
  const session = new FakeSession();
  let time = 1_000;
  const hub = createHub({ open: async () => session });
  const recorder = createRecorder({ attach: hub.attach, dir, now: () => time, qualities: { auto: [], saver: [] }, ...(maxBytes ? { maxBytes } : {}) });
  return { dir, session, hub, recorder, tick: (ms: number) => { time += ms; } };
}

test("recorder writes a finished MP4 from the shared stream", async t => {
  const f = await recorderFixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const started = await f.recorder.start({ quality: "auto", max_s: 60 });
  assert.equal(started.state, "recording");
  await assert.rejects(f.recorder.start({}), { status: 409, code: "recording_busy" });
  await assert.rejects(f.recorder.file(), { status: 409 });
  await flush();
  f.session.video(2, 0, config(BASE));
  f.session.video(1, 0, annexB(slice(true)));
  f.tick(33); f.session.video(0, 33_333, annexB(slice(false)));
  f.tick(500);
  const stopped = await f.recorder.stop() as Record<string, unknown>;
  assert.equal(stopped.state, "done");
  assert.equal(stopped.frames, 2);
  assert.equal(stopped.stop_reason, "stopped");
  const { path, bytes } = await f.recorder.file();
  const file = new Uint8Array(await readFile(path));
  assert.equal(file.length, bytes);
  const boxes = parse(file);
  assert.deepEqual(boxes.stsz, [44, 44]);
  assert.deepEqual(boxes.sizes, [[720, 1280]]);
  // The recorder left the hub, so the session lingers with no viewers.
  assert.equal(f.session.closed, false);
  await f.recorder.discard();
  await assert.rejects(readFile(path), { code: "ENOENT" });
  assert.equal(f.recorder.status().state, "none");
  f.hub.closeAll();
});

test("recorder stops on max bytes and when the stream closes", async t => {
  const f = await recorderFixture(200);
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  await f.recorder.start({});
  await flush();
  f.session.video(2, 0, config(BASE));
  for (let i = 0; i < 6; i++) f.session.video(i ? 0 : 1, i * 33_333, annexB(slice(!i)));
  await flush(); await flush();
  const { path } = await f.recorder.file();
  assert.equal((f.recorder.status() as Record<string, unknown>).stop_reason, "max_bytes");
  assert.ok((await readFile(path)).length > 0);

  await f.recorder.start({});
  await flush();
  f.session.close();
  await flush(); await flush();
  // No frame arrived before the stream closed: the recording fails and leaves no file.
  await assert.rejects(f.recorder.file(), { status: 409, code: "recording_failed" });
  f.hub.closeAll();
});

test("recorder rejects bad options", async () => {
  const f = await recorderFixture();
  await assert.rejects(f.recorder.start({ quality: "ultra" }), { status: 400 });
  await assert.rejects(f.recorder.start({ max_s: 0 }), { status: 400 });
  await assert.rejects(f.recorder.start({ max_s: 1.5 }), { status: 400 });
  await assert.rejects(f.recorder.stop(), { status: 404 });
  await rm(f.dir, { recursive: true, force: true });
});
