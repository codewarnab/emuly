import { controlMessage } from "./scrcpy-protocol.mjs";

// One scrcpy session per stream quality, shared by all viewers of that quality.
// Before, each WebSocket started its own scrcpy server (jar push, adb forward, app_process,
// encoder start), so every reload and every second tab waited 1.8-6.5 s for a picture.
// A session stays for LINGER_MS after its last viewer leaves, so a reload joins it at once.
//
// Rules that keep a shared stream correct:
// - A late viewer gets the stored config packet, then a replay of the last keyframe and the delta
//   frames after it, so its screen matches the phone at once. A {type:"replay", frames} message comes
//   first, so the browser decodes the burst and draws only its last frame. With no saved keyframe,
//   the join asks the encoder for one (scrcpy reset video), at most once per RESET_GAP_MS.
// - Flow control: the browser acks each video packet it receives ({type:"ack", pts}). Once a viewer
//   acks, the hub knows its real delay, including network buffers it cannot see. When the oldest
//   unacked frame is older than LAG_MS, or too many bytes are unacked, the hub drops live frames
//   for that viewer before it sends them, and waits for a fresh keyframe.
// - A slow viewer drops frames until the next keyframe, or is closed alone. It never stalls others.
// - Each viewer has its own pointer ID range, and its touches and keys are released when it leaves.
// - A clipboard reply goes only to the viewer that asked for it.
// - Audio (Opus) goes only to viewers that ask for it. A late viewer gets the stored audio config
//   first. A slow viewer skips audio packets; it never waits for audio.

const LINGER_MS = 60_000;
// After a quality change, the old quality's session has no viewers. Stop it sooner, so two
// encoders do not run for a full minute on a 2-core phone.
const SWITCH_LINGER_MS = 5_000;
const RESET_GAP_MS = 500;
const SLOW_BYTES = 1024 * 1024;
const DROP_BYTES = 4 * 1024 * 1024;
const START_TIMEOUT_MS = 20_000;
const CLIPBOARD_REPLY_MS = 2_000;
const MAX_VIEWERS = 8;
// Replay: the saved keyframe and delta frames for a late viewer. Past this size, start again from a new keyframe.
// The frame cap keeps the burst small enough for the browser's decode limits.
const REPLAY_BYTES = 2 * 1024 * 1024, REPLAY_FRAMES = 90;
// Flow control limits for a viewer that acks.
const LAG_MS = 500;
const UNACKED_BYTES = 3 * 1024 * 1024;
// No ack for this long: the browser is gone or stuck. Close it; the page reconnects.
const ACK_DEAD_MS = 15_000;
const ptsOf = packet => packet.length >= 9 ? Number(packet.readBigUInt64BE(1)) : NaN;
const CONFIG = 2, KEY = 1, AUDIO = 4;
const OPEN = 1;

/**
 * @param {{ open: (quality: string) => Promise<any>, share?: boolean, lingerMs?: number,
 *   switchLingerMs?: number, now?: () => number, capabilities?: string[] }} options
 * open(quality) resolves to a session (see openScrcpy) that emits "packet", "device" and "close".
 * share=false gives every viewer its own session that ends with it (the old behaviour).
 */
export function createHub({ open, share = true, lingerMs = LINGER_MS, switchLingerMs = SWITCH_LINGER_MS,
  now = Date.now, capabilities = ["clipboard"] }) {
  const entries = new Map();
  let serial = 0;

  function end(entry) {
    if (entry.ended) return;
    entry.ended = true;
    clearTimeout(entry.linger);
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    for (const viewer of [...entry.viewers]) viewer.close();
    entry.session?.close();
  }

  function entryFor(quality) {
    const key = share ? quality : `${quality}#${++serial}`;
    const live = entries.get(key);
    if (live && !live.ended) return live;
    const entry = { key, quality, viewers: new Set(), session: null, config: null, audioConfig: null, replay: [], replayBytes: 0, ended: false,
      linger: undefined, resetAt: -Infinity, clipboard: null };
    entries.set(key, entry);
    entry.ready = open(quality).then(session => {
      if (entry.ended) { session.close(); throw new Error("session ended"); }
      entry.session = session;
      session.on("packet", packet => fanOut(entry, packet));
      session.on("device", message => deliver(entry, message));
      session.on("close", () => end(entry));
      session.start?.();
      return session;
    });
    entry.ready.catch(() => end(entry));
    return entry;
  }

  function requestKeyframe(entry) {
    if (!entry.session || now() - entry.resetAt < RESET_GAP_MS) return;
    entry.resetAt = now();
    entry.session.write(controlMessage({ type: "keyframe" }));
  }

  function fanOut(entry, packet) {
    const flags = packet[0];
    if (flags & AUDIO) {
      if (flags & CONFIG) entry.audioConfig = packet;
      for (const viewer of [...entry.viewers]) viewer.audio(packet);
      return;
    }
    if (flags & CONFIG) { entry.config = packet; entry.replay = []; entry.replayBytes = 0; }
    else if (flags & KEY) { entry.replay = [packet]; entry.replayBytes = packet.length; }
    else if (entry.replay.length) {
      entry.replay.push(packet); entry.replayBytes += packet.length;
      if (entry.replayBytes > REPLAY_BYTES || entry.replay.length > REPLAY_FRAMES) { entry.replay = []; entry.replayBytes = 0; requestKeyframe(entry); }
    }
    for (const viewer of [...entry.viewers]) viewer.video(packet, flags);
  }

  function deliver(entry, message) {
    if (message.type !== "clipboard") return;
    const asked = entry.clipboard;
    entry.clipboard = null;
    if (asked && now() - asked.at <= CLIPBOARD_REPLY_MS) asked.viewer.json({ type: "clipboard", text: message.text.slice(0, 8000) });
  }

  function idle(entry) {
    if (entry.ended || entry.viewers.size) return;
    const otherLive = [...entries.values()].some(other => other !== entry && other.viewers.size);
    const wait = share ? (otherLive ? switchLingerMs : lingerMs) : 0;
    if (!wait) return end(entry);
    clearTimeout(entry.linger);
    entry.linger = setTimeout(() => end(entry), wait);
    entry.linger.unref?.();
  }

  /** options.audio: also send Opus packets (flag AUDIO). */
  function attach(ws, quality, { audio = false } = {}) {
    const entry = entryFor(quality);
    if (entry.viewers.size >= MAX_VIEWERS) { ws.close(); return; }
    clearTimeout(entry.linger);
    const used = new Set([...entry.viewers].map(viewer => viewer.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const pointerBase = slot * 32;
    const touches = new Map(), keys = new Set();
    let closed = false, ready = false, waitKey = true, inputAccepted = false, count = 0, window = now();
    // Flow control state. acking turns on with the first ack, so an older page keeps the old behaviour.
    let acking = false, unackedBytes = 0, held = false;
    const inFlight = [];
    const track = packet => {
      const pts = ptsOf(packet);
      if (!Number.isFinite(pts)) return;
      inFlight.push({ pts, at: now(), bytes: packet.length }); unackedBytes += packet.length;
    };
    const lagging = () => acking && inFlight.length > 0 && (now() - inFlight[0].at > LAG_MS || unackedBytes > UNACKED_BYTES);
    const ack = pts => {
      if (!Number.isFinite(pts)) return;
      acking = true;
      while (inFlight.length && inFlight[0].pts <= pts) unackedBytes -= inFlight.shift().bytes;
      // The window opened again after a hold: a fresh keyframe restarts the picture.
      if (held && !lagging()) { held = false; requestKeyframe(entry); }
    };
    const sendVideo = packet => { ws.send(packet); if (!(packet[0] & CONFIG)) track(packet); };
    const joined = Boolean(entry.session);

    const viewer = {
      slot,
      json(message) { if (!closed && ws.readyState === OPEN) ws.send(JSON.stringify(message)); },
      video(packet, flags) {
        if (closed || !ready) return;
        if (ws.bufferedAmount > DROP_BYTES) return viewer.close();
        const config = Boolean(flags & CONFIG), key = Boolean(flags & KEY);
        if (!config && ws.bufferedAmount > SLOW_BYTES) { waitKey = true; requestKeyframe(entry); return; }
        if (!config && acking && inFlight.length && now() - inFlight[0].at > ACK_DEAD_MS) return viewer.close();
        if (!config && lagging()) { waitKey = true; held = true; return; }
        if (!config && !key && waitKey) return;
        if (key) waitKey = false;
        sendVideo(packet);
      },
      audio(packet) {
        if (closed || !ready || !audio) return;
        if (!(packet[0] & CONFIG) && ws.bufferedAmount > SLOW_BYTES) return;
        ws.send(packet);
      },
      close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        if (entry.session) {
          for (const input of touches.values()) entry.session.write(controlMessage({ ...input, action: "cancel" }, { pointerBase }));
          for (const key of keys) entry.session.write(controlMessage({ type: "key", key, action: "up" }));
        }
        if (entry.clipboard?.viewer === viewer) entry.clipboard = null;
        entry.viewers.delete(viewer);
        ws.close();
        idle(entry);
      },
    };
    entry.viewers.add(viewer);
    // A viewer moved to this quality: idle sessions of other qualities stop sooner.
    if (share) for (const other of [...entries.values()]) if (other !== entry && !other.viewers.size) idle(other);
    ws.on("close", viewer.close); ws.on("error", viewer.close);
    const timer = setTimeout(viewer.close, START_TIMEOUT_MS);

    ws.on("message", (data, binary) => {
      if (closed || !ready) return;
      try {
        // Acks come with every frame, so they do not count toward the input rate limit.
        if (!binary && data.length < 64) {
          const text = data.toString();
          if (text.startsWith('{"type":"ack"')) { ack(Number(JSON.parse(text).pts)); return; }
        }
        if (now() - window >= 1000) { count = 0; window = now(); }
        if (binary || data.length > 16_384 || ++count > 240 || entry.session.writableLength > 65_536) return viewer.close();
        const input = JSON.parse(data.toString());
        if (input.type === "ping" && Number.isFinite(input.time)) {
          viewer.json({ type: "pong", time: input.time, server: now(), inputAccepted, capabilities });
          inputAccepted = false;
          return;
        }
        const bytes = controlMessage(input, { pointerBase });
        // A keyframe request comes from the browser decoder (stale video), not from the user.
        if (input.type === "keyframe") { requestKeyframe(entry); return; }
        inputAccepted = true;
        if (input.type === "touch") {
          if (["up", "cancel"].includes(input.action)) touches.delete(input.pointer);
          else touches.set(input.pointer, input);
        }
        if (input.type === "key" && input.action) {
          if (input.action === "up") keys.delete(input.key); else keys.add(input.key);
        }
        if (input.type === "get-clipboard") entry.clipboard = { viewer, at: now() };
        entry.session.write(bytes);
      } catch { viewer.close(); }
    });

    entry.ready.then(session => {
      if (closed) return;
      clearTimeout(timer);
      ready = true;
      if (joined) console.log(`[scrcpy] join quality=${entry.quality} viewers=${entry.viewers.size}`);
      // A late viewer needs the config packet before any frame. Then it gets the replay (the saved
      // keyframe and the delta frames after it) and continues with live frames, or, with no replay,
      // a fresh keyframe.
      if (entry.config) {
        ws.send(entry.config);
        if (entry.replay.length) {
          viewer.json({ type: "replay", frames: entry.replay.length });
          for (const packet of entry.replay) sendVideo(packet);
          waitKey = false;
        } else requestKeyframe(entry);
      }
      if (audio && entry.audioConfig) ws.send(entry.audioConfig);
      // Do not remove this wakeup "to save work". The emulator encoder often sends no frame while
      // the screen is static, so a new viewer saw no picture until a user touched the phone. A reset
      // alone has the same problem. KEYCODE_WAKEUP (224) makes Android redraw without changing any
      // app or screen state. Do not use home, back, or a touch here; those change what the user sees.
      const wake = setTimeout(() => { if (!closed) session.write(controlMessage({ type: "key", key: "wakeup" })); }, 300);
      wake.unref?.();
    }, () => viewer.close());
  }

  function closeAll() {
    for (const entry of [...entries.values()]) end(entry);
  }

  return { attach, closeAll, sessions: () => entries.size,
    /** Viewers of all sessions. A running recording counts as one viewer. */
    viewers: () => [...entries.values()].reduce((sum, entry) => sum + entry.viewers.size, 0) };
}
