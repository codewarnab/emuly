// H.264 packets -> MP4 file, with no new encoding. The runner (agent recordings) and the browser
// (the Record button) both use this file, so it uses only Uint8Array and DataView, not Buffer.
//
// scrcpy already sends compressed H.264 (Annex B: NAL units after 00 00 01 start codes).
// An MP4 needs the same NAL units with a 4-byte length in front, plus tables (moov) that list
// each sample's size, time and keyframe flag. So a recording only copies bytes: no decode, no encode.
//
// Audio: scrcpy also sends Opus packets (flag AUDIO). They become a second track ("Opus" sample
// entry with a dOps box). scrcpy counts video and audio pts from separate origins, so the two
// tracks are lined up by arrival time: audio that arrives before the first video sample is dropped,
// and an edit list delays the audio track by the gap.
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
const AUDIO_RATE = 48_000; // Opus always decodes at 48 kHz
const OPUS_FRAME = 960; // 20 ms, the length of one scrcpy Opus packet
const toUs = value => Math.round(value * 1_000_000 / TIMESCALE);

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
  return { sps, pps, ...spsSize(sps[0]), key: Array.from(data).join(","), bytes: data.slice() };
}

/**
 * add() takes one scrcpy packet: { config, key, pts (µs), data (Annex B), at (arrival ms) }.
 * It returns the bytes to append to the file, or null for a packet that is not a sample
 * (a config packet, or a frame before the first keyframe).
 *
 * journal (optional) gets one short text line for each new config and each sample, after add()
 * returns that sample. The tables live only in memory until finish(), so a killed process leaves
 * an MP4 without a moov. restoreMp4Muxer() rebuilds the tables from the journal lines.
 */
export function createMp4Muxer({ journal } = {}) {
  const configs = [];
  const sizes = [], times = [], syncs = [], runs = [], offsets = [];
  const audio = { head: null, headHex: null, sizes: [], pts: [], offsets: [], firstAt: 0 };
  let videoFirstAt = 0;
  let pending = null, current = -1, waitKey = true;
  let bytes = 0, lastPts = 0, lastAt = 0, lastTime = 0;

  // The one place that changes the tables. add() and restoreMp4Muxer() both come here.
  function record(index, size, time, key, at) {
    if (index !== current) { current = index; runs.push({ config: index, first: sizes.length }); }
    if (key) syncs.push(sizes.length + 1);
    if (!sizes.length) videoFirstAt = at;
    offsets.push(HEAD_SIZE + bytes);
    sizes.push(size); times.push(time);
    bytes += size; lastAt = at; lastTime = time;
  }

  function recordAudio(size, pts, at) {
    if (!audio.sizes.length) audio.firstAt = at;
    audio.offsets.push(HEAD_SIZE + bytes); audio.sizes.push(size); audio.pts.push(pts);
    bytes += size;
  }

  /** @param {{ audio?: boolean, config: boolean, key?: boolean, pts: number, data: Uint8Array, at?: number }} packet */
  function add({ audio: isAudio = false, config, key, pts, data, at = Date.now() }) {
    if (isAudio) return addAudio({ config, pts, data, at });
    if (config) { pending = parseConfig(data); waitKey = true; return null; }
    if (waitKey && !key) return null;
    const units = nalUnits(data).filter(unit => ![7, 8, 9].includes(unit[0] & 31));
    if (!units.length) return null;
    let index = current;
    if (pending) {
      index = configs.findIndex(item => item.key === pending.key);
      if (index < 0) { index = configs.push(pending) - 1; journal?.(`c ${toHex(pending.bytes)}`); }
      pending = null;
    }
    if (index < 0) return null;
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
    lastPts = pts;
    record(index, sample.length, time, key, at);
    journal?.(`s ${index} ${sample.length} ${time} ${key ? 1 : 0} ${at}`);
    return sample;
  }

  // An Opus packet is one sample, copied as it is. The config packet is the OpusHead.
  function addAudio({ config, pts, data, at }) {
    if (config) {
      audio.head = parseOpusHead(data);
      const hex = toHex(data);
      if (hex !== audio.headHex) { audio.headHex = hex; journal?.(`h ${hex}`); }
      return null;
    }
    if (!audio.head || !sizes.length) return null;
    const sample = data.slice();
    recordAudio(sample.length, pts, at);
    journal?.(`a ${sample.length} ${pts} ${at}`);
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
    const sound = audio.sizes.length ? audioTrack(audio, Math.max(0, audio.firstAt - videoFirstAt)) : null;
    const endUs = Math.max(toUs(total), sound ? sound.delayUs + sound.totalUs : 0);
    const head = new Uint8Array(HEAD_SIZE);
    head.set(box("ftyp", ascii("isom"), u32(0x200), ascii("isomiso2avc1mp41")));
    const mdat = new DataView(head.buffer, 32);
    mdat.setUint32(0, 1); head.set(ascii("mdat"), 36); mdat.setBigUint64(8, BigInt(16 + bytes));
    const tail = moov({ configs, sizes, durations, syncs, runs, offsets, total, endUs, sound });
    return { head, tail, durationMs: Math.round(endUs / 1000), frames: sizes.length, audioSamples: audio.sizes.length,
      bytes: HEAD_SIZE + bytes + tail.length };
  }

  /** Rebuild the tables from journal lines. Only for restoreMp4Muxer(). */
  function replay(text, dataBytes) {
    // Only whole lines: a line cut inside a number still has five numbers.
    for (const line of text.split("\n").slice(0, -1)) {
      const [kind, ...fields] = line.split(" ");
      if (kind === "h" && fields.length === 1 && /^([0-9a-f]{2})+$/.test(fields[0])) {
        try { audio.head = parseOpusHead(fromHex(fields[0])); } catch { break; }
        continue;
      }
      if (kind === "a") {
        const [size, pts, at] = fields.map(Number);
        if (fields.length !== 3 || ![size, pts, at].every(Number.isFinite) || !audio.head || !sizes.length || size < 1 || bytes + size > dataBytes) break;
        recordAudio(size, pts, at);
        continue;
      }
      if (kind === "c" && fields.length === 1 && /^([0-9a-f]{2})+$/.test(fields[0])) {
        try { configs.push(parseConfig(fromHex(fields[0]))); } catch { break; }
        continue;
      }
      const [index, size, time, key, at] = fields.map(Number);
      // A line cut by the crash, or a sample that did not reach the disk, ends the replay.
      if (kind !== "s" || fields.length !== 5 || ![index, size, time, at].every(Number.isFinite)) break;
      if (!configs[index] || size < 5 || time < lastTime || bytes + size > dataBytes) break;
      record(index, size, time, key === 1, at);
    }
  }

  return { add, finish, replay, get audioSamples() { return audio.sizes.length; }, get frames() { return sizes.length; }, get bytes() { return HEAD_SIZE + bytes; },
    get lastAt() { return lastAt; } };
}

/**
 * A muxer with the samples that a journal lists and that the file holds. dataBytes is the file
 * size minus HEAD_SIZE. The caller truncates the file to muxer.bytes, then writes finish().
 */
export function restoreMp4Muxer(text, dataBytes) {
  const muxer = createMp4Muxer();
  muxer.replay(text, dataBytes);
  return muxer;
}

const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
const fromHex = hex => Uint8Array.from(hex.match(/../g) ?? [], pair => parseInt(pair, 16));

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

const toMovie = us => Math.round(us / (1_000_000 / MOVIE_TIMESCALE));
function timeToSample(durations) {
  const steps = [];
  for (const duration of durations) {
    if (steps.length && steps.at(-1)[1] === duration) steps.at(-1)[0]++;
    else steps.push([1, duration]);
  }
  return full("stts", 0, 0, table(steps.length, 2, set => steps.forEach(([count, duration], i) => { set(i * 2, count); set(i * 2 + 1, duration); })));
}
// One chunk per sample: audio and video samples alternate in mdat, so samples of one track are not contiguous.
function chunkOffsets(offsets) {
  const co64 = new Uint8Array(4 + offsets.length * 8);
  const view = new DataView(co64.buffer);
  view.setUint32(0, offsets.length);
  offsets.forEach((offset, i) => view.setBigUint64(4 + i * 8, BigInt(offset)));
  return full("co64", 0, 0, co64);
}
const sampleSizes = sizes => full("stsz", 0, 0, u32(0), table(sizes.length, 1, set => sizes.forEach((size, i) => set(i, size))));

function moov({ configs, sizes, durations, syncs, runs, offsets, total, endUs, sound }) {
  const first = configs[runs[0].config];
  const stss = full("stss", 0, 0, table(syncs.length, 1, set => syncs.forEach((sample, i) => set(i, sample))));
  // One sample per chunk. A new stsc entry starts where the sample description (SPS/PPS) changes.
  const stsc = full("stsc", 0, 0, table(runs.length, 3, set => runs.forEach((run, i) => {
    set(i * 3, run.first + 1); set(i * 3 + 1, 1); set(i * 3 + 2, run.config + 1);
  })));
  const stbl = box("stbl", full("stsd", 0, 0, u32(configs.length), ...configs.map(avc1)), timeToSample(durations), stss, stsc,
    sampleSizes(sizes), chunkOffsets(offsets));
  const minf = box("minf", full("vmhd", 0, 1, zeros(8)), box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))), stbl);
  const mdia = box("mdia", full("mdhd", 0, 0, zeros(8), u32(TIMESCALE), u32(total), u16(0x55c4), u16(0)),
    full("hdlr", 0, 0, u32(0), ascii("vide"), zeros(12), ascii("Emuly video\0")), minf);
  const tkhd = full("tkhd", 0, 3, zeros(8), u32(1), zeros(4), u32(toMovie(toUs(total))), zeros(8), zeros(8), MATRIX,
    u32(first.width * 0x10000), u32(first.height * 0x10000));
  const mvhd = full("mvhd", 0, 0, zeros(8), u32(MOVIE_TIMESCALE), u32(toMovie(endUs)), u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(sound ? 3 : 2));
  const video = box("trak", tkhd, mdia);
  return sound ? box("moov", mvhd, video, soundTrak(sound)) : box("moov", mvhd, video);
}

/** OpusHead (RFC 7845, section 5.1): the scrcpy audio config packet. Its integers are little endian. */
function parseOpusHead(data) {
  if (data.length < 19 || new TextDecoder().decode(data.subarray(0, 8)) !== "OpusHead") throw new Error("Audio config without OpusHead");
  if (data[18] !== 0) throw new Error("Only mono and stereo Opus are supported");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { channels: data[9], preSkip: view.getUint16(10, true), inputRate: view.getUint32(12, true), gain: view.getInt16(16, true) };
}

function audioTrack(audio, delayMs) {
  const { pts } = audio;
  const durations = pts.map((value, i) => {
    const step = i + 1 < pts.length ? pts[i + 1] - value : -1;
    return step > 0 && step < MAX_GAP_US ? Math.max(1, Math.round(step * AUDIO_RATE / 1_000_000)) : OPUS_FRAME;
  });
  const samples = durations.reduce((sum, value) => sum + value, 0);
  return { ...audio, durations, samples, delayUs: delayMs * 1000, totalUs: Math.round(samples * 1_000_000 / AUDIO_RATE) };
}

function soundTrak({ head, sizes, offsets, durations, samples, delayUs, totalUs }) {
  // dOps is the OpusHead in big endian, without the magic and with version 0 (Opus in ISOBMFF, 4.3.2).
  const dops = box("dOps", u8(0, head.channels), u16(head.preSkip), u32(head.inputRate), u16(head.gain & 0xffff), u8(0));
  const opus = box("Opus", zeros(6), u16(1), zeros(8), u16(head.channels), u16(16), zeros(4), u32(AUDIO_RATE * 0x10000), dops);
  const stsc = full("stsc", 0, 0, table(1, 3, set => { set(0, 1); set(1, 1); set(2, 1); }));
  const stbl = box("stbl", full("stsd", 0, 0, u32(1), opus), timeToSample(durations), stsc, sampleSizes(sizes), chunkOffsets(offsets));
  const minf = box("minf", full("smhd", 0, 0, zeros(4)), box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))), stbl);
  const mdia = box("mdia", full("mdhd", 0, 0, zeros(8), u32(AUDIO_RATE), u32(samples), u16(0x55c4), u16(0)),
    full("hdlr", 0, 0, u32(0), ascii("soun"), zeros(12), ascii("Emuly audio\0")), minf);
  const delay = toMovie(delayUs), length = toMovie(totalUs);
  // Edit list: an empty edit (media_time -1) for the time before the first audio sample, then the audio.
  const edits = [...(delay ? [[delay, 0xffff_ffff]] : []), [length, 0]];
  const elst = full("elst", 0, 0, u32(edits.length), ...edits.flatMap(([duration, time]) => [u32(duration), u32(time), u32(0x10000)]));
  const tkhd = full("tkhd", 0, 3, zeros(8), u32(2), zeros(4), u32(delay + length), zeros(8), u16(0), u16(1), u16(0x100), u16(0), MATRIX, u32(0), u32(0));
  return box("trak", tkhd, box("edts", elst), mdia);
}

/** Read the 17-byte browser packet header written by ScrcpyPackets (scrcpy-protocol.mjs). */
export function readPacket(packet, at = Date.now()) {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  return { audio: Boolean(packet[0] & 4), config: Boolean(packet[0] & 2), key: Boolean(packet[0] & 1), pts: Number(view.getBigUint64(1)),
    data: packet.subarray(17), at };
}
