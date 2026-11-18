// H.264 packets -> MP4 file, with no new encoding. The runner (agent recordings) and the browser
// (the Record button) both use this file, so it uses only Uint8Array and DataView, not Buffer.
//
// scrcpy already sends compressed H.264 (Annex B: NAL units after 00 00 01 start codes).
// An MP4 needs the same NAL units with a 4-byte length in front, plus tables (moov) that list
// each sample's size, time and keyframe flag. So a recording only copies bytes: no decode, no encode.
//
// File layout: [head: ftyp + mdat header] [samples ...] [tail: moov].
// The head has a fixed size (HEAD_SIZE) but its mdat size is known only at the end, so a writer
// first writes HEAD_SIZE placeholder bytes, then each sample from add(), then finish().tail,
// and last puts finish().head at offset 0. The moov is at the end of the file: players read it
// after a download. For playback during a download (streaming), move it with ffmpeg -movflags faststart.

export const HEAD_SIZE = 48;
// 90 kHz is the standard video time unit. With 1 MHz (scrcpy's microseconds), ffmpeg guessed a
// 1,000,000 fps rate for this variable-rate phone video and warned about non-increasing dts.
const TIMESCALE = 90_000;
const ticks = us => Math.round(us * TIMESCALE / 1_000_000);
const MOVIE_TIMESCALE = 1000;
const MAX_GAP_US = 10_000_000;
const MIN_FRAME_US = 1_000;

/** Split Annex B bytes into NAL units (subarrays, no copy). Accepts 3- and 4-byte start codes. */
// Jump between 0x01 bytes with the native indexOf: a byte-by-byte loop here took 70% of the mux time.
export function nalUnits(bytes) {
  const units = [];
  let start = -1;
  for (let i = bytes.indexOf(1, 2); i >= 0; i = bytes.indexOf(1, i + 1)) {
    if (bytes[i - 1] !== 0 || bytes[i - 2] !== 0) continue;
    if (start >= 0) units.push(bytes.subarray(start, trimZeros(bytes, start, i - 2)));
    start = i + 1;
  }
  if (start >= 0 && start < bytes.length) units.push(bytes.subarray(start));
  return units.filter(unit => unit.length);
}
// The zero before 00 00 01 in a 4-byte start code belongs to the start code, not to the NAL unit.
function trimZeros(bytes, start, end) { while (end > start && bytes[end - 1] === 0) end--; return end; }

/** Width and height from an H.264 sequence parameter set (NAL type 7), after cropping. */
export function spsSize(sps) {
  // Remove emulation prevention bytes: 00 00 03 -> 00 00. The zero count restarts after each removed 03.
  const raw = [];
  for (let i = 1, zeros = 0; i < sps.length; i++) {
    if (zeros >= 2 && sps[i] === 3) { zeros = 0; continue; }
    zeros = sps[i] === 0 ? zeros + 1 : 0;
    raw.push(sps[i]);
  }
  let bit = 0;
  const u = n => { let v = 0; for (let k = 0; k < n; k++, bit++) {
    if (bit >> 3 >= raw.length) throw new Error("Short SPS");
    v = v * 2 + ((raw[bit >> 3] >> (7 - (bit & 7))) & 1); } return v; };
  const ue = () => { let zeros = 0; while (!u(1)) if (++zeros > 31) throw new Error("Invalid SPS"); return 2 ** zeros - 1 + u(zeros); };
  const se = () => { const v = ue(); return v & 1 ? (v + 1) / 2 : -v / 2; };
  const profile = u(8); u(16); ue();
  let chroma = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = ue(); if (chroma === 3) u(1);
    ue(); ue(); u(1);
    if (u(1)) for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
      if (!u(1)) continue;
      let last = 8, next = 8;
      for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + se() + 256) % 256; last = next || last; }
    }
  }
  ue();
  const poc = ue();
  if (poc === 0) ue();
  else if (poc === 1) { u(1); se(); se(); const n = ue(); for (let i = 0; i < n; i++) se(); }
  ue(); u(1);
  const mbWidth = ue() + 1, mapHeight = ue() + 1, frameOnly = u(1);
  if (!frameOnly) u(1);
  u(1);
  let [left, right, top, bottom] = [0, 0, 0, 0];
  if (u(1)) [left, right, top, bottom] = [ue(), ue(), ue(), ue()];
  const unitX = chroma === 1 || chroma === 2 ? 2 : 1;
  const unitY = (chroma === 1 ? 2 : 1) * (2 - frameOnly);
  return { width: mbWidth * 16 - (left + right) * unitX, height: (2 - frameOnly) * mapHeight * 16 - (top + bottom) * unitY };
}

function parseConfig(data) {
  const units = nalUnits(data);
  const sps = units.filter(unit => (unit[0] & 31) === 7), pps = units.filter(unit => (unit[0] & 31) === 8);
  if (!sps.length || !pps.length || sps[0].length < 4) throw new Error("Config packet without SPS and PPS");
  return { sps, pps, ...spsSize(sps[0]), key: Array.from(data).join(",") };
}

/**
 * add() takes one scrcpy packet: { config, key, pts (µs), data (Annex B), at (arrival ms) }.
 * It returns the bytes to append to the file, or null for a packet that is not a sample
 * (a config packet, or a frame before the first keyframe).
 */
export function createMp4Muxer() {
  const configs = [];
  const sizes = [], times = [], syncs = [], runs = [];
  let pending = null, current = -1, waitKey = true;
  let bytes = 0, lastPts = 0, lastAt = 0, lastTime = 0;

  /** @param {{ config: boolean, key?: boolean, pts: number, data: Uint8Array, at?: number }} packet */
  function add({ config, key, pts, data, at = Date.now() }) {
    if (config) { pending = parseConfig(data); waitKey = true; return null; }
    if (waitKey && !key) return null;
    const units = nalUnits(data).filter(unit => ![7, 8, 9].includes(unit[0] & 31));
    if (!units.length) return null;
    if (pending) {
      const known = configs.findIndex(item => item.key === pending.key);
      const index = known >= 0 ? known : configs.push(pending) - 1;
      pending = null;
      if (index !== current) { current = index; runs.push({ config: index, first: sizes.length, offset: HEAD_SIZE + bytes }); }
    }
    if (current < 0) return null;
    waitKey = false;
    const sample = new Uint8Array(units.reduce((sum, unit) => sum + 4 + unit.length, 0));
    const view = new DataView(sample.buffer);
    let at4 = 0;
    for (const unit of units) { view.setUint32(at4, unit.length); sample.set(unit, at4 + 4); at4 += 4 + unit.length; }
    // Use the encoder's pts. A pts that jumps back or far ahead (an encoder restart) falls back to arrival time.
    let time = 0;
    if (sizes.length) {
      const step = pts - lastPts;
      time = lastTime + (step > 0 && step < MAX_GAP_US ? step : Math.max(MIN_FRAME_US, (at - lastAt) * 1000));
    }
    lastPts = pts; lastAt = at; lastTime = time;
    if (key) syncs.push(sizes.length + 1);
    sizes.push(sample.length); times.push(time);
    bytes += sample.length;
    return sample;
  }

  /** endAt: the stop time (ms). The last frame stays on screen until then, as the phone showed it. */
  function finish(endAt = Date.now()) {
    if (!sizes.length) throw new Error("No video frames were recorded.");
    // Convert each start time to 90 kHz ticks, then take differences, so rounding never adds up.
    // u32 time at 90 kHz lasts 13 hours; recording.mjs stops at 30 minutes.
    const lastUs = Math.min(MAX_GAP_US, Math.max(MIN_FRAME_US, (endAt - lastAt) * 1000));
    const starts = times.map(ticks);
    const end = Math.max(starts.at(-1) + 1, ticks(times.at(-1) + lastUs));
    const durations = new Uint32Array(sizes.length);
    for (let i = 0; i < sizes.length; i++) durations[i] = Math.max(1, (starts[i + 1] ?? end) - starts[i]);
    const total = durations.reduce((sum, value) => sum + value, 0);
    const head = new Uint8Array(HEAD_SIZE);
    head.set(box("ftyp", ascii("isom"), u32(0x200), ascii("isomiso2avc1mp41")));
    const mdat = new DataView(head.buffer, 32);
    mdat.setUint32(0, 1); head.set(ascii("mdat"), 36); mdat.setBigUint64(8, BigInt(16 + bytes));
    const tail = moov({ configs, sizes, durations, syncs, runs, total });
    return { head, tail, durationMs: Math.round(total * 1000 / TIMESCALE), frames: sizes.length, bytes: HEAD_SIZE + bytes + tail.length };
  }

  return { add, finish, get frames() { return sizes.length; }, get bytes() { return HEAD_SIZE + bytes; } };
}

// ---- ISO BMFF boxes ----
const encoder = new TextEncoder();
const ascii = text => encoder.encode(text);
const u8 = (...values) => new Uint8Array(values);
const u16 = value => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, value); return b; };
const u32 = value => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value); return b; };
const zeros = n => new Uint8Array(n);
function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
function box(type, ...parts) {
  const body = concat(parts);
  return concat([u32(8 + body.length), ascii(type), body]);
}
const full = (type, version, flags, ...parts) => box(type, u8(version, flags >> 16, flags >> 8 & 255, flags & 255), ...parts);
const MATRIX = concat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]);
// A table of u32 values in one allocation; stsz alone has one entry per frame.
function table(count, perRow, fill) {
  const out = new Uint8Array(4 + count * perRow * 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, count);
  fill((i, value) => view.setUint32(4 + i * 4, value));
  return out;
}

function avc1(config) {
  const avcc = box("avcC", u8(1, config.sps[0][1], config.sps[0][2], config.sps[0][3], 0xff, 0xe0 | config.sps.length),
    ...config.sps.flatMap(sps => [u16(sps.length), sps]), u8(config.pps.length), ...config.pps.flatMap(pps => [u16(pps.length), pps]));
  return box("avc1", zeros(6), u16(1), zeros(16), u16(config.width), u16(config.height), u32(0x480000), u32(0x480000),
    zeros(4), u16(1), zeros(32), u16(0x18), u16(0xffff), avcc);
}

function moov({ configs, sizes, durations, syncs, runs, total }) {
  const movie = Math.round(total / (TIMESCALE / MOVIE_TIMESCALE));
  const first = configs[runs[0].config];
  const steps = [];
  for (const duration of durations) {
    if (steps.length && steps.at(-1)[1] === duration) steps.at(-1)[0]++;
    else steps.push([1, duration]);
  }
  const stts = full("stts", 0, 0, table(steps.length, 2, set => steps.forEach(([count, duration], i) => { set(i * 2, count); set(i * 2 + 1, duration); })));
  const stss = full("stss", 0, 0, table(syncs.length, 1, set => syncs.forEach((sample, i) => set(i, sample))));
  const stsc = full("stsc", 0, 0, table(runs.length, 3, set => runs.forEach((run, i) => {
    const end = runs[i + 1]?.first ?? sizes.length;
    set(i * 3, i + 1); set(i * 3 + 1, end - run.first); set(i * 3 + 2, run.config + 1);
  })));
  const stsz = full("stsz", 0, 0, u32(0), table(sizes.length, 1, set => sizes.forEach((size, i) => set(i, size))));
  const co64 = new Uint8Array(4 + runs.length * 8);
  const offsets = new DataView(co64.buffer);
  offsets.setUint32(0, runs.length);
  runs.forEach((run, i) => offsets.setBigUint64(4 + i * 8, BigInt(run.offset)));
  const stbl = box("stbl", full("stsd", 0, 0, u32(configs.length), ...configs.map(avc1)), stts, stss, stsc, stsz, full("co64", 0, 0, co64));
  const minf = box("minf", full("vmhd", 0, 1, zeros(8)), box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))), stbl);
  const mdia = box("mdia", full("mdhd", 0, 0, zeros(8), u32(TIMESCALE), u32(total), u16(0x55c4), u16(0)),
    full("hdlr", 0, 0, u32(0), ascii("vide"), zeros(12), ascii("Emuly video\0")), minf);
  const tkhd = full("tkhd", 0, 3, zeros(8), u32(1), zeros(4), u32(movie), zeros(8), zeros(8), MATRIX,
    u32(first.width * 0x10000), u32(first.height * 0x10000));
  const mvhd = full("mvhd", 0, 0, zeros(8), u32(MOVIE_TIMESCALE), u32(movie), u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(2));
  return box("moov", mvhd, box("trak", tkhd, mdia));
}

/** Read the 17-byte browser packet header written by ScrcpyPackets (scrcpy-protocol.mjs). */
export function readPacket(packet, at = Date.now()) {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  return { config: Boolean(packet[0] & 2), key: Boolean(packet[0] & 1), pts: Number(view.getBigUint64(1)),
    data: packet.subarray(17), at };
}
