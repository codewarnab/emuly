import { EventEmitter } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMp4Muxer, HEAD_SIZE, readPacket, restoreMp4Muxer } from "./mp4-mux.mjs";

// Screen recording for agents: POST /recording/start, test the app, POST /recording/stop,
// then GET /recording/file returns an MP4.
//
// The recorder joins the shared scrcpy session (scrcpy-hub.mjs) as one more viewer, so it
// starts no second encoder: it only copies the H.264 and Opus packets that viewers already get into an
// MP4 file (mp4-mux.mjs). A browser viewer at the same quality shares the same encoder.
// One recording at a time per phone. A new start deletes the last file.
//
// Crash safety. The MP4 tables (moov) are written at stop. A runner that is killed first
// (codespace stop, OOM kill) would leave a file that no player opens. So each recording also has:
//   <id>.journal  one line per video or audio sample (size, time, keyframe), appended while it records
//   <id>.json     id, quality, start time, state and notes
//
// Notes: POST /recording/mark {text} while it records. Each note gets t_s, its time in the MP4.
// The MP4 starts at the first frame (video_start_at), not at the start request, so a note
// time is right in the video. An agent's own clock times would be off by first_frame_ms.
// recover() runs when the runner starts: it rebuilds the tables of a recording that has a journal,
// so GET /recording/file returns the video up to the last frame that reached the disk.

export const MAX_DURATION_S = 30 * 60;
export const DEFAULT_DURATION_S = 10 * 60;
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;
// The first frame after a cold boot took 11 s on a real phone (scrcpy server and encoder start).
// start() waits for it, so a caller that acts right after start() is on the video.
// The runner's HTTP calls get 40 s (phone-link.ts), so 20 s leaves room.
export const FIRST_FRAME_WAIT_MS = 20_000;
export const MAX_NOTES = 1000;
export const MAX_NOTE_CHARS = 500;
const OPEN = 1;
const FILE_PATTERN = /^emuly-recording-([0-9a-f-]{36})\.json$/;

export class RecordingError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const paths = (dir, id) => {
  const base = join(dir, `emuly-recording-${id}`);
  return { path: `${base}.mp4`, journalPath: `${base}.journal`, metaPath: `${base}.json` };
};

/**
 * @param {{ attach: (ws: any, quality: string) => void, dir?: string, now?: () => number,
 *   maxBytes?: number, firstFrameWaitMs?: number, qualities: Record<string, unknown> }} options
 */
export function createRecorder({ attach, dir = tmpdir(), now = Date.now, maxBytes = MAX_FILE_BYTES,
  firstFrameWaitMs = FIRST_FRAME_WAIT_MS, qualities }) {
  let current = null;
  /** True while a start runs its first awaits. A second start then gets 409, so no recording runs untracked. */
  let starting = false;
  let ready = null;

  function view(recording) {
    if (!recording) return { state: "none" };
    const { id, state, quality, startedAt, endedAt, reason, result, muxer, error, videoStartAt, notes = [] } = recording;
    return { id, state, quality, started_at: new Date(startedAt).toISOString(),
      ...(videoStartAt ? { video_start_at: new Date(videoStartAt).toISOString() } : {}), notes: notes.length,
      duration_ms: result?.durationMs ?? (endedAt ?? now()) - startedAt,
      frames: result?.frames ?? muxer?.frames ?? 0, audio_packets: result?.audioSamples ?? muxer?.audioSamples ?? 0, bytes: result?.bytes ?? muxer?.bytes ?? 0,
      ...(recording.firstFrameMs !== undefined ? { first_frame_ms: recording.firstFrameMs } : {}),
      ...(reason ? { stop_reason: reason } : {}), ...(error ? { error } : {}) };
  }

  const saveMeta = recording => writeFile(recording.metaPath, JSON.stringify({ ...view(recording), max_s: recording.maxS,
    video_start_ms: recording.videoStartAt ?? null, note_list: recording.notes ?? [] }));

  async function start({ quality = "auto", max_s = DEFAULT_DURATION_S } = {}) {
    if (!Object.hasOwn(qualities, quality)) throw new RecordingError(400, "invalid_input", `quality must be one of: ${Object.keys(qualities).join(", ")}.`);
    if (!Number.isInteger(max_s) || max_s < 1 || max_s > MAX_DURATION_S) throw new RecordingError(400, "invalid_input", `max_s must be a whole number from 1 to ${MAX_DURATION_S}.`);
    if (starting) throw new RecordingError(409, "recording_busy", "A recording is already running. Stop it first.");
    starting = true;
    try {
      await recover();
      if (current?.state === "recording" || current?.state === "stopping") throw new RecordingError(409, "recording_busy", "A recording is already running. Stop it first.");
      if (current) await discard();
      await mkdir(dir, { recursive: true });
    } catch (error) { starting = false; throw error; }
    const id = randomUUID();
    let file, journal, muxer;
    try {
      file = createWriteStream(paths(dir, id).path);
      journal = createWriteStream(paths(dir, id).journalPath);
      muxer = createMp4Muxer({ journal: line => journal.write(`${line}\n`) });
    } catch (error) { starting = false; file?.destroy(); journal?.destroy(); throw error; }
    const recording = current = { id, ...paths(dir, id), file, journal, muxer, quality, maxS: max_s, state: "recording",
      startedAt: now(), endedAt: null, reason: null, result: null, error: null, done: null, timer: null, socket: null,
      doneSet: null, firstFrameMs: null, videoStartAt: null, notes: [] };
    // `current` now holds this recording, so the state check refuses the next start.
    starting = false;
    recording.doneSet = new Promise(resolve => { recording.onDone = resolve; });
    let sawFrame;
    const firstFrame = new Promise(resolve => { sawFrame = resolve; });
    // A start that fails before the first frame must not leave a stale "recording" record.
    await saveMeta(recording);
    file.write(new Uint8Array(HEAD_SIZE));
    file.on("error", error => finish(recording, "write_failed", error));
    journal.on("error", error => finish(recording, "write_failed", error));
    // A WebSocket-like viewer for the hub. bufferedAmount is the disk queue: when the disk is slow,
    // the hub skips frames until the next keyframe for this viewer only, as it does for a slow network.
    const socket = Object.assign(new EventEmitter(), {
      readyState: OPEN,
      get bufferedAmount() { return file.writableLength; },
      send(packet) {
        if (recording.state !== "recording" || typeof packet === "string") return;
        let sample;
        try { sample = muxer.add(readPacket(packet, now())); }
        catch (error) { return void finish(recording, "bad_video", error); }
        if (!sample) return;
        file.write(sample);
        if (recording.firstFrameMs === null) {
          // The MP4's time 0 is this frame (mp4-mux.mjs: the first sample's arrival time).
          recording.videoStartAt = now(); recording.firstFrameMs = recording.videoStartAt - recording.startedAt; sawFrame();
        }
        if (muxer.bytes >= maxBytes) void finish(recording, "max_bytes");
      },
      close() {
        if (socket.readyState !== OPEN) return;
        socket.readyState = 3;
        socket.emit("close");
        void finish(recording, "stream_closed");
      },
    });
    recording.socket = socket;
    recording.timer = setTimeout(() => void finish(recording, "max_duration"), max_s * 1000);
    recording.timer.unref?.();
    attach(socket, quality);
    // Wait for the first frame, a stop, or the time limit. Without a frame the recording still
    // runs, and first_frame_ms stays null in the reply.
    let waited;
    await Promise.race([firstFrame, recording.doneSet, new Promise(resolve => { waited = setTimeout(resolve, firstFrameWaitMs); })]);
    clearTimeout(waited);
    console.log(`[recording] start id=${id} quality=${quality} max_s=${max_s} first_frame_ms=${recording.firstFrameMs}`);
    return view(recording);
  }

  // Ends the recording once and writes the MP4 tables. Every stop path comes here.
  function finish(recording, reason, failure) {
    if (recording.done) return recording.done;
    recording.state = "stopping";
    recording.reason = reason;
    recording.endedAt = now();
    clearTimeout(recording.timer);
    recording.onDone?.();
    recording.done = (async () => {
      const { file, journal, muxer, path } = recording;
      await Promise.all([file, journal].map(stream => new Promise(resolve => {
        if (stream.closed) resolve(); else { stream.once("close", resolve); stream.end(); }
      })));
      if (failure) throw failure;
      await writeTables(path, muxer, recording.endedAt, recording);
      // The tables are on disk: the journal is no longer needed.
      await rm(recording.journalPath, { force: true });
      await saveMeta(recording);
      console.log(`[recording] done id=${recording.id} reason=${reason} frames=${recording.result.frames} audio=${recording.result.audioSamples} bytes=${recording.result.bytes} ms=${recording.result.durationMs}`);
    })().catch(error => fail(recording, reason, error));
    // Leave the hub after done is set: the hub's close calls back into finish().
    recording.socket?.close();
    return recording.done;
  }

  async function writeTables(path, muxer, endAt, recording) {
    const result = muxer.finish(endAt);
    const handle = await open(path, "r+");
    try {
      await handle.write(result.tail, 0, result.tail.length, muxer.bytes);
      await handle.write(result.head, 0, result.head.length, 0);
    } finally { await handle.close(); }
    recording.result = result;
    recording.state = "done";
  }

  async function fail(recording, reason, error) {
    recording.state = "failed";
    recording.error = String(error?.message ?? error).slice(0, 200);
    console.log(`[recording] failed id=${recording.id} reason=${reason} error=${recording.error.replace(/\s+/g, "_")}`);
    await Promise.all([recording.path, recording.journalPath].map(path => rm(path, { force: true })));
    await saveMeta(recording).catch(() => {});
  }

  /**
   * Once per runner: load the last recording from dir, finish one that a killed runner left
   * without tables, and delete older ones. Later calls return the same promise.
   */
  function recover() {
    ready ??= (async () => {
      let names = [];
      try { names = await readdir(dir); } catch { return; }
      const found = [];
      for (const name of names) {
        const id = FILE_PATTERN.exec(name)?.[1];
        if (!id) continue;
        try { found.push({ id, meta: JSON.parse(await readFile(join(dir, name), "utf8")) }); }
        catch { await removeAll(id); }
      }
      found.sort((a, b) => Date.parse(b.meta.started_at) - Date.parse(a.meta.started_at));
      for (const { id } of found.slice(1)) await removeAll(id);
      if (!found.length || current) return;
      const { id, meta } = found[0];
      const recording = { id, ...paths(dir, id), quality: meta.quality, maxS: meta.max_s, startedAt: Date.parse(meta.started_at),
        state: meta.state, endedAt: Date.parse(meta.started_at) + (meta.duration_ms ?? 0), reason: meta.stop_reason ?? null,
        result: meta.state === "done" ? { durationMs: meta.duration_ms, frames: meta.frames, bytes: meta.bytes } : null,
        error: meta.error ?? null, muxer: null, done: Promise.resolve(), socket: null,
        videoStartAt: meta.video_start_ms ?? null, notes: Array.isArray(meta.note_list) ? meta.note_list : [] };
      current = recording;
      if (meta.state === "done" || meta.state === "failed") return;
      // The runner died while it recorded or wrote the tables.
      recording.reason = "recovered";
      try {
        const [{ size }, journal] = await Promise.all([stat(recording.path), readFile(recording.journalPath, "utf8")]);
        const muxer = restoreMp4Muxer(journal, size - HEAD_SIZE);
        if (!muxer.frames) throw new Error("No video frames reached the disk.");
        // Drop a half-written sample at the end, and any old tables from a stop that did not finish.
        await truncate(recording.path, muxer.bytes);
        const { mtimeMs } = await stat(recording.journalPath);
        recording.endedAt = Math.max(muxer.lastAt, Math.min(mtimeMs, muxer.lastAt + 1000));
        await writeTables(recording.path, muxer, recording.endedAt, recording);
        await rm(recording.journalPath, { force: true });
        await saveMeta(recording);
        console.log(`[recording] recovered id=${id} frames=${recording.result.frames} bytes=${recording.result.bytes}`);
      } catch (error) {
        await fail(recording, "recovered", error);
      }
    })();
    return ready;
  }

  const removeAll = id => Promise.all(Object.values(paths(dir, id)).map(path => rm(path, { force: true })));

  async function stop() {
    await recover();
    if (!current) throw new RecordingError(404, "no_recording", "No recording exists. Start one first.");
    if (current.state === "recording") await finish(current, "stopped");
    else await current.done;
    return view(current);
  }

  /** The finished MP4: { path, bytes, id }. 409 while it still records. */
  async function file() {
    await recover();
    if (!current) throw new RecordingError(404, "no_recording", "No recording exists. Start one first.");
    if (current.state === "recording") throw new RecordingError(409, "recording_busy", "The recording still runs. Stop it first.");
    // An automatic stop (time or size limit) may still write the MP4 tables: wait for it.
    await current.done;
    if (current.state === "failed") throw new RecordingError(409, "recording_failed", current.error ?? "The recording failed.");
    const { size } = await stat(current.path);
    return { path: current.path, bytes: size, id: current.id, durationMs: current.result?.durationMs ?? 0 };
  }

  async function discard() {
    await recover();
    const recording = current;
    if (!recording) return { state: "none" };
    if (recording.state === "recording") await finish(recording, "discarded");
    else await recording.done;
    current = null;
    await removeAll(recording.id);
    return { state: "none" };
  }

  /** Add a note at the current time in the video. Only while the recording runs. */
  async function mark({ text } = {}) {
    await recover();
    if (typeof text !== "string" || !text.trim() || text.length > MAX_NOTE_CHARS) {
      throw new RecordingError(400, "invalid_input", `text must be 1 to ${MAX_NOTE_CHARS} characters.`);
    }
    if (current?.state !== "recording") throw new RecordingError(409, "not_recording", "No recording runs. Start one first.");
    if (current.notes.length >= MAX_NOTES) throw new RecordingError(409, "too_many_notes", `A recording keeps up to ${MAX_NOTES} notes.`);
    // Before the first frame, the note is at time 0.
    const note = { t_s: current.videoStartAt ? Math.max(0, now() - current.videoStartAt) / 1000 : 0, text: text.trim() };
    current.notes.push(note);
    await saveMeta(current);
    return note;
  }

  /** The notes of the last recording, with the video's start time. */
  async function notes() {
    await recover();
    if (!current) throw new RecordingError(404, "no_recording", "No recording exists. Start one first.");
    const duration = current.result?.durationMs;
    return { id: current.id, state: current.state,
      video_start_at: current.videoStartAt ? new Date(current.videoStartAt).toISOString() : null,
      ...(duration !== undefined ? { duration_ms: duration } : {}), notes: current.notes };
  }

  async function status() {
    await recover();
    return view(current);
  }

  /** Finish a running recording (SIGTERM). Resolves when its tables are on disk. */
  async function close() {
    if (current?.state === "recording") await finish(current, "runner_stopped");
    else await current?.done;
  }

  return { start, stop, file, discard, status, mark, notes, recover, close };
}
