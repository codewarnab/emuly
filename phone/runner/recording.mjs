import { EventEmitter } from "node:events";
import { createWriteStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMp4Muxer, HEAD_SIZE, readPacket } from "./mp4-mux.mjs";

// Screen recording for agents: POST /recording/start, test the app, POST /recording/stop,
// then GET /recording/file returns an MP4.
//
// The recorder joins the shared scrcpy session (scrcpy-hub.mjs) as one more viewer, so it
// starts no second encoder: it only copies the H.264 packets that viewers already get into an
// MP4 file (mp4-mux.mjs). A browser viewer at the same quality shares the same encoder.
// One recording at a time per phone. A new start deletes the last file.

export const MAX_DURATION_S = 30 * 60;
export const DEFAULT_DURATION_S = 10 * 60;
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const OPEN = 1;

export class RecordingError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/**
 * @param {{ attach: (ws: any, quality: string) => void, dir?: string, now?: () => number,
 *   maxBytes?: number, qualities: Record<string, unknown> }} options
 */
export function createRecorder({ attach, dir = tmpdir(), now = Date.now, maxBytes = MAX_FILE_BYTES, qualities }) {
  let current = null;

  function view(recording) {
    if (!recording) return { state: "none" };
    const { id, state, quality, startedAt, endedAt, reason, result, muxer, error } = recording;
    return { id, state, quality, started_at: new Date(startedAt).toISOString(),
      duration_ms: result?.durationMs ?? (endedAt ?? now()) - startedAt,
      frames: result?.frames ?? muxer.frames, bytes: result?.bytes ?? muxer.bytes,
      ...(reason ? { stop_reason: reason } : {}), ...(error ? { error } : {}) };
  }

  async function start({ quality = "auto", max_s = DEFAULT_DURATION_S } = {}) {
    if (!Object.hasOwn(qualities, quality)) throw new RecordingError(400, "invalid_input", `quality must be one of: ${Object.keys(qualities).join(", ")}.`);
    if (!Number.isInteger(max_s) || max_s < 1 || max_s > MAX_DURATION_S) throw new RecordingError(400, "invalid_input", `max_s must be a whole number from 1 to ${MAX_DURATION_S}.`);
    if (current?.state === "recording" || current?.state === "stopping") throw new RecordingError(409, "recording_busy", "A recording is already running. Stop it first.");
    if (current) await discard();
    const id = randomUUID();
    const path = join(dir, `emuly-recording-${id}.mp4`);
    const file = createWriteStream(path);
    const muxer = createMp4Muxer();
    const recording = current = { id, path, file, muxer, quality, state: "recording", startedAt: now(), endedAt: null,
      reason: null, result: null, error: null, done: null, timer: null, socket: null };
    file.write(new Uint8Array(HEAD_SIZE));
    file.on("error", error => finish(recording, "write_failed", error));
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
    console.log(`[recording] start id=${id} quality=${quality} max_s=${max_s}`);
    return view(recording);
  }

  // Ends the recording once and writes the MP4 tables. Every stop path comes here.
  function finish(recording, reason, failure) {
    if (recording.done) return recording.done;
    recording.state = "stopping";
    recording.reason = reason;
    recording.endedAt = now();
    clearTimeout(recording.timer);
    recording.done = (async () => {
      const { file, muxer, path } = recording;
      await new Promise(resolve => { if (file.closed) resolve(); else { file.once("close", resolve); file.end(); } });
      if (failure) throw failure;
      const result = muxer.finish(recording.endedAt);
      const handle = await open(path, "r+");
      try {
        await handle.write(result.tail, 0, result.tail.length, muxer.bytes);
        await handle.write(result.head, 0, result.head.length, 0);
      } finally { await handle.close(); }
      recording.result = result;
      recording.state = "done";
      console.log(`[recording] done id=${recording.id} reason=${reason} frames=${result.frames} bytes=${result.bytes} ms=${result.durationMs}`);
    })().catch(error => {
      recording.state = "failed";
      recording.error = String(error?.message ?? error).slice(0, 200);
      console.log(`[recording] failed id=${recording.id} reason=${reason} error=${recording.error.replace(/\s+/g, "_")}`);
      void rm(recording.path, { force: true });
    });
    // Leave the hub after done is set: the hub's close calls back into finish().
    recording.socket?.close();
    return recording.done;
  }

  async function stop() {
    if (!current) throw new RecordingError(404, "no_recording", "No recording exists. Start one first.");
    await finish(current, "stopped");
    return view(current);
  }

  /** The finished MP4: { path, bytes, id }. 409 while it still records. */
  async function file() {
    if (!current) throw new RecordingError(404, "no_recording", "No recording exists. Start one first.");
    if (current.state === "recording") throw new RecordingError(409, "recording_busy", "The recording still runs. Stop it first.");
    // An automatic stop (time or size limit) may still write the MP4 tables: wait for it.
    await current.done;
    if (current.state === "failed") throw new RecordingError(409, "recording_failed", current.error ?? "The recording failed.");
    const { size } = await stat(current.path);
    return { path: current.path, bytes: size, id: current.id };
  }

  async function discard() {
    const recording = current;
    if (!recording) return { state: "none" };
    if (recording.state === "recording") await finish(recording, "discarded");
    else await recording.done;
    current = null;
    await rm(recording.path, { force: true });
    return { state: "none" };
  }

  return { start, stop, file, discard, status: () => view(current), close: () => current && finish(current, "runner_stopped") };
}
