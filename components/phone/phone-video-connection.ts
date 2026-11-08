import { avcCodec, retryDelays, videoPacket } from "../../lib/phone/phone-video.ts";
import { parseStreamTicket, readPhoneResponse } from "../../lib/phone/phone-response.ts";
import { phoneTiming } from "./phone-timing.ts";

export type VideoConnectionState = "connecting" | "streaming" | "retrying" | "suspended" | "fallback" | "disposed";
type VideoConnectionOptions = {
  id: string;
  quality: string;
  onState: (state: VideoConnectionState) => void;
  // Frames are borrowed for this synchronous callback and always closed afterward.
  onFrame: (frame: VideoFrame) => boolean;
  onStats: (stats: { fps: number; delay: number }) => void;
  onSaver: () => void;
};

/** Starts one live session. dispose() is idempotent and prevents all later delivery.
 * Attempts move connecting -> streaming/retrying; visibility suspends and resumes them.
 * Unsupported browsers stay in fallback. Disposal is terminal for either path.
 */
export function createPhoneVideoConnection(options: VideoConnectionOptions) {
  if (!("VideoDecoder" in window)) return createFallback(options);
  const { id, quality, onState, onFrame, onStats, onSaver } = options;
  let state: VideoConnectionState = "suspended";
  let socket: WebSocket | null = null;
  let retry = 0, timer: ReturnType<typeof setTimeout> | undefined, decoder: VideoDecoder | undefined;
  const transition = (next: VideoConnectionState) => {
    if (state === "disposed" || state === next) return;
    state = next; onState(next);
  };
  const disposed = () => state === "disposed";
  const animations = new Set<number>();
  const current = (ws: WebSocket, attempt: AbortController) => state !== "disposed" && socket === ws && request === attempt && !attempt.signal.aborted;
  let calibrated = false;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let presence: ReturnType<typeof setInterval> | undefined;
  let report: ReturnType<typeof phoneTiming> | undefined;
  let acceptFramesAfter = performance.now();
  let lastResume = -Infinity;
  let request: AbortController | undefined, frames = 0, tick = performance.now(), offset = 0, delay = 0;
  const sent = new Map<number, { sent: number; receivedAt: number }>();
  const stop = () => {
    request?.abort(); clearTimeout(timer); clearInterval(watchdog); clearTimeout(resumeTimer);
    clearInterval(presence);
    const ws = socket; socket = null;
    if (ws) { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; ws.close(); }
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = undefined; sent.clear();
    for (const animation of animations) cancelAnimationFrame(animation);
    animations.clear();
  };
  function afterPaint(callback: () => void) {
    const handle = requestAnimationFrame(() => { animations.delete(handle); callback(); });
    animations.add(handle);
  }
  function scheduleRetry() {
    if (state === "disposed" || document.hidden) return;
    transition("retrying");
    timer = setTimeout(connect, retryDelays[Math.min(retry++, 2)]);
  }
  function send(input: Record<string, unknown>) {
    if (state !== "streaming" || socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(input)); return true;
  }
  function dispose() {
    if (state === "disposed") return;
    transition("disposed"); clearTimeout(hiddenTimer); stop();
    report = undefined;
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("focus", resume);
  }
  async function connect() {
    if (state === "disposed" || document.hidden) return;
    stop(); transition("connecting");
    calibrated = false; frames = 0; tick = performance.now();
    request = new AbortController();
    const attempt = request;
    const attemptStart = performance.now();
    try {
      const response = await fetch(`/app/phones/${encodeURIComponent(id)}/stream-ticket`, { method: "POST", signal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]) });
      if (!response.ok) throw new Error("Stream unavailable");
      const { ticket, attemptId } = await readPhoneResponse(response, parseStreamTicket);
      if (disposed() || document.hidden || attempt !== request || attempt.signal.aborted) return;
      report = phoneTiming(id, attemptId, attemptStart);
      report("presence");
      let issuedAt = performance.now(), renewing = false;
      presence = setInterval(() => {
        if (request !== attempt || attempt.signal.aborted) return;
        report?.("presence");
        if (!attemptId || renewing || performance.now() - issuedAt < 15 * 60000) return;
        renewing = true;
        const started = performance.now();
        void fetch(`/app/phones/${encodeURIComponent(id)}/stream-ticket`, { method: "POST", signal: attempt.signal })
          .then(async response => {
            if (!response.ok) return;
            const { attemptId: renewed } = await readPhoneResponse(response, parseStreamTicket);
            if (state === "disposed" || request !== attempt || attempt.signal.aborted) return;
            report = phoneTiming(id, renewed, started); issuedAt = started;
            report("presence");
          }).catch(() => {}).finally(() => { renewing = false; });
      }, 30000);
      const url = new URL(`/app/phones/${encodeURIComponent(id)}/stream`, location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", ticket);
      url.searchParams.set("quality", quality);
      const ws = new WebSocket(url); socket = ws; ws.binaryType = "arraybuffer";
      let config = new Uint8Array(), needKey = true, lastMessage = Date.now();
      watchdog = setInterval(() => {
        if (!current(ws, attempt)) return;
        if (Date.now() - lastMessage > 15_000) { ws.close(); return; }
        // Heartbeats must continue even when Android's screen is static.
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", time: Date.now() }));
      }, 5000);
      let decoded = false, painted = false;
      decoder = new VideoDecoder({
        output(frame) {
          try {
            if (!current(ws, attempt)) return;
            const timing = sent.get(frame.timestamp);
            if (!decoded) { decoded = true; report?.("first_decoded"); }
            sent.delete(frame.timestamp);
            if (document.hidden || !timing || timing.receivedAt < acceptFramesAfter) return;
            if (!onFrame(frame)) return;
            if (!painted) {
              painted = true;
              // Two animation callbacks observe a rendering opportunity after canvas submission.
              afterPaint(() => afterPaint(() => {
                if (current(ws, attempt) && !document.hidden) report?.("first_painted");
              }));
            }
            delay = calibrated ? Math.max(0, Date.now() + offset - timing.sent) : 0;
            clearTimeout(resumeTimer);
            transition("streaming"); retry = 0; frames++;
            const now = performance.now();
            if (now - tick >= 1000) {
              onStats({ fps: Math.round(frames * 1000 / (now - tick)), delay: Math.round(delay) });
              if (quality === "auto" && delay > 350) onSaver();
              frames = 0; tick = now;
            }
          } finally { frame.close(); }
        },
        error() { if (!current(ws, attempt)) return; report?.("reconnect", "decoder_failed"); ws.close(); },
      });
      ws.onopen = () => { if (current(ws, attempt)) ws.send(JSON.stringify({ type: "ping", time: Date.now() })); };
      ws.onmessage = event => {
        if (!current(ws, attempt)) return;
        lastMessage = Date.now();
        try {
          if (typeof event.data === "string") {
            const pong = JSON.parse(event.data);
            if (pong.type === "pong") { offset = pong.server - (Date.now() + pong.time) / 2; calibrated = true; }
            return;
          }
          const packet = videoPacket(event.data);
          if (packet.config) {
            config = new Uint8Array(packet.data);
            decoder!.configure({ codec: avcCodec(config), optimizeForLatency: true });
            needKey = true; return;
          }
          if (decoder!.state !== "configured" || (needKey && !packet.key)) return;
          if (decoder!.decodeQueueSize > 5) { report?.("reconnect", "queue_full"); if (quality === "auto") onSaver(); ws.close(); return; }
          let data = packet.data;
          if (packet.key) { data = new Uint8Array(config.length + packet.data.length); data.set(config); data.set(packet.data, config.length); }
          needKey = false; sent.set(packet.pts, { sent: packet.sent, receivedAt: performance.now() });
          if (sent.size > 120) { ws.close(); return; }
          decoder!.decode(new EncodedVideoChunk({ type: packet.key ? "key" : "delta", timestamp: packet.pts, data }));
        } catch { ws.close(); }
      };
      ws.onerror = () => { if (current(ws, attempt)) ws.close(); };
      ws.onclose = () => {
        if (!current(ws, attempt)) return;
        report?.("reconnect", "socket_closed"); stop();
        scheduleRetry();
      };
    } catch {
      if (attempt === request && !attempt.signal.aborted) { stop(); scheduleRetry(); }
    }
  }
  const resume = () => {
    if (document.hidden || state === "disposed") return;
    clearTimeout(hiddenTimer);
    if (performance.now() - lastResume < 250) return;
    lastResume = performance.now();
    acceptFramesAfter = lastResume;
    transition("connecting");
    report?.("presence");
    retry = 0;
    const ws = socket;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping", time: Date.now() }));
      // A static screen may not produce another frame. Reconnect for a fresh keyframe.
      clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => { void connect(); }, 2000);
    } else { void connect(); }
  };
  const visibility = () => {
    if (disposed()) return;
    if (!document.hidden) { resume(); return; }
    transition("suspended");
    report?.("presence", "hidden");
    clearTimeout(hiddenTimer);
    clearTimeout(resumeTimer);
    // Brief window switches keep the capture process and connection alive.
    hiddenTimer = setTimeout(stop, 3000);
  };
  onState(state);
  document.addEventListener("visibilitychange", visibility); void connect();
  window.addEventListener("focus", resume);
  return { send, reportFallback: () => report?.("screenshot_fallback"), dispose };
}

function createFallback({ id, onState }: VideoConnectionOptions) {
  const request = new AbortController();
  let report: ReturnType<typeof phoneTiming> | undefined, enabled = true;
  const issue = async () => {
    const started = performance.now();
    try {
      const response = await fetch(`/app/phones/${encodeURIComponent(id)}/stream-ticket`, { method: "POST", signal: request.signal });
      if (!response.ok) return;
      const { attemptId } = await readPhoneResponse(response, parseStreamTicket);
      if (request.signal.aborted) return;
      enabled = typeof attemptId === "string";
      report = phoneTiming(id, attemptId, started);
      report("presence");
    } catch { /* Diagnostics cannot interrupt screenshot fallback. */ }
  };
  onState("fallback"); void issue();
  const presence = setInterval(() => report?.("presence"), 30000);
  const renewal = setInterval(() => { if (enabled) void issue(); }, 15 * 60000);
  const visibility = () => report?.("presence", document.hidden ? "hidden" : "none");
  document.addEventListener("visibilitychange", visibility);
  return {
    send: (_input: Record<string, unknown>) => false,
    reportFallback: () => report?.("screenshot_fallback"),
    dispose() {
      if (request.signal.aborted) return;
      request.abort(); clearInterval(presence); clearInterval(renewal);
      report = undefined; onState("disposed");
      document.removeEventListener("visibilitychange", visibility);
    },
  };
}
