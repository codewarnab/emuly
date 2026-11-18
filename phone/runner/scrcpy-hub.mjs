import { controlMessage } from "./scrcpy-protocol.mjs";

// One scrcpy session per stream quality, shared by all viewers of that quality.
// Before, each WebSocket started its own scrcpy server (jar push, adb forward, app_process,
// encoder start), so every reload and every second tab waited 1.8-6.5 s for a picture.
// A session stays for LINGER_MS after its last viewer leaves, so a reload joins it at once.
//
// Rules that keep a shared stream correct:
// - A late viewer gets the stored config packet first, then nothing until a keyframe.
//   A join asks the encoder for a new keyframe (scrcpy reset video), at most once per RESET_GAP_MS.
// - A slow viewer drops frames until the next keyframe, or is closed alone. It never stalls others.
// - Each viewer has its own pointer ID range, and its touches and keys are released when it leaves.
// - A clipboard reply goes only to the viewer that asked for it.

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
const CONFIG = 2, KEY = 1;
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
    const entry = { key, quality, viewers: new Set(), session: null, config: null, ended: false,
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
    if (flags & CONFIG) entry.config = packet;
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

  function attach(ws, quality) {
    const entry = entryFor(quality);
    if (entry.viewers.size >= MAX_VIEWERS) { ws.close(); return; }
    clearTimeout(entry.linger);
    const used = new Set([...entry.viewers].map(viewer => viewer.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const pointerBase = slot * 32;
    const touches = new Map(), keys = new Set();
    let closed = false, ready = false, waitKey = true, inputAccepted = false, count = 0, window = now();
    const joined = Boolean(entry.session);

    const viewer = {
      slot,
      json(message) { if (!closed && ws.readyState === OPEN) ws.send(JSON.stringify(message)); },
      video(packet, flags) {
        if (closed || !ready) return;
        if (ws.bufferedAmount > DROP_BYTES) return viewer.close();
        const config = Boolean(flags & CONFIG), key = Boolean(flags & KEY);
        if (!config && ws.bufferedAmount > SLOW_BYTES) { waitKey = true; requestKeyframe(entry); return; }
        if (!config && !key && waitKey) return;
        if (key) waitKey = false;
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
      // A late viewer needs the config packet before any frame, then a fresh keyframe.
      if (entry.config) { ws.send(entry.config); requestKeyframe(entry); }
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

  return { attach, closeAll, sessions: () => entries.size };
}
