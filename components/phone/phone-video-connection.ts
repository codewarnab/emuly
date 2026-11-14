import { avcCodec, retryDelays, videoPacket } from "../../lib/phone/phone-video.ts";
import { parseStreamTicket, readPhoneResponse } from "../../lib/phone/phone-response.ts";
import { phoneTiming } from "./phone-timing.ts";

const HIDDEN_DISCONNECT_MS = 60_000;
const RESUME_FRAME_WAIT_MS = 5_000;
const FIRST_FRAME_WAIT_MS = 6_000;
// Browser -> Vercel -> GitHub port forward -> runner can take several seconds to open.
const CONNECT_WAIT_MS = 20_000;

export type VideoConnectionState = "connecting" | "streaming" | "retrying" | "suspended" | "fallback" | "stopped" | "disposed";
type VideoConnectionOptions = {
  id: string;
  quality: string;
  onState: (state: VideoConnectionState) => void;
  // Frames are borrowed for this synchronous callback and always closed afterward.
  onFrame: (frame: VideoFrame) => boolean;
  onStats: (stats: { fps: number; delay: number }) => void;
  onSaver: () => void;
  onCapabilities?: (capabilities: string[]) => void;
  onClipboard?: (clipboard: { text: string; at: number }) => void;
};

/** The ticket route answers 409 with a distinct code once the phone row is no longer running. */
async function phoneStopped(response: Response) {
  if (response.status !== 409) return false;
  try {
    const body = await response.json() as { errorCode?: unknown };
    return body?.errorCode === "phone_stopped";
  } catch { return false; }
}

/** Starts one live session. dispose() is idempotent and prevents all later delivery.
 * Attempts move connecting -> streaming/retrying; visibility suspends and resumes them.
 * Unsupported browsers stay in fallback. Disposal is terminal for either path.
 */
export function createPhoneVideoConnection(options: VideoConnectionOptions) {
  if (!("VideoDecoder" in window)) return createFallback(options);
  const { id, quality, onState, onFrame, onStats, onSaver, onCapabilities, onClipboard } = options;
  let state: VideoConnectionState = "suspended";
  let socket: WebSocket | null = null;
  // The browser cannot decode this H.264 stream. Each retry starts a new scrcpy on the runner,
  // so after DECODE_LIMIT failures use the screenshot view instead.
  let decodeFailures = 0;
  const DECODE_LIMIT = 2;
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
  let firstFrame: ReturnType<typeof setTimeout> | undefined;
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let presence: ReturnType<typeof setInterval> | undefined;
  let report: ReturnType<typeof phoneTiming> | undefined;
  let acceptFramesAfter = performance.now();
  let lastResume = -Infinity;
  let request: AbortController | undefined, frames = 0, tick = performance.now(), offset = 0, delay = 0;
  const sent = new Map<number, { sent: number; receivedAt: number }>();
  const stop = () => {
    request?.abort(); clearTimeout(timer); clearInterval(watchdog); clearTimeout(firstFrame); clearTimeout(resumeTimer);
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
  function decodeFailed() {
    if (++decodeFailures < DECODE_LIMIT) { socket?.close(); return; }
    stop(); transition("fallback");
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
      if (!response.ok) {
        // GitHub answers 401 on the forwarded port while a codespace shuts down. Retrying or switching
        // to the tunnel cannot work then, so we tell the page the phone stopped. Do not remove this check.
        // 401 (logged out), 403 (no access) and 404 (deleted) do not heal by retry. Stop, and let the
        // page refresh show the login, the error or "Phone stopped".
        if ([401, 403, 404].includes(response.status) || await phoneStopped(response)) {
          if (attempt === request && !attempt.signal.aborted) {
            report?.("reconnect", "phone_stopped");
            stop(); transition("stopped");
          }
          return;
        }
        throw new Error("Stream unavailable");
      }
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
      let config = new Uint8Array(), needKey = true, lastMessage = Date.now(), lastVideo = lastMessage;
      let decoded = false, painted = false, opened = false;
      // Do not remove or merge this check into the pong-based watchdog "for efficiency".
      // Pongs prove only that the socket is open, not that video works. When pongs counted as
      // liveness, a socket with no video stayed open for minutes. The page showed an old image
      // ("Reconnecting · showing last image") until the user pressed a key or reloaded.
      // Rule: no painted frame within FIRST_FRAME_WAIT_MS after the socket opens -> close and retry.
      // The socket itself gets CONNECT_WAIT_MS to open. Do not start the frame wait before open:
      // a slow open then always failed, and the page showed "Reconnecting" again and again.
      // After the first paint, a static screen may send no frames. That is normal, so do not close then.
      const stale = () => { report?.("reconnect", "stale"); ws.close(); };
      firstFrame = setTimeout(() => { if (current(ws, attempt) && !opened) stale(); }, CONNECT_WAIT_MS);
      watchdog = setInterval(() => {
        if (!current(ws, attempt) || !opened) return;
        if (!painted && Date.now() - lastVideo >= FIRST_FRAME_WAIT_MS) { stale(); return; }
        if (Date.now() - lastMessage > 15_000) { ws.close(); return; }
        // Heartbeats must continue even when Android's screen is static.
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", time: Date.now() }));
      }, 5000);
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
              painted = true; clearTimeout(firstFrame);
              // Two animation callbacks observe a rendering opportunity after canvas submission.
              afterPaint(() => afterPaint(() => {
                if (current(ws, attempt) && !document.hidden) report?.("first_painted");
              }));
            }
            delay = calibrated ? Math.max(0, Date.now() + offset - timing.sent) : 0;
            clearTimeout(resumeTimer);
            transition("streaming"); retry = 0; decodeFailures = 0; frames++;
            const now = performance.now();
            if (now - tick >= 1000) {
              onStats({ fps: Math.round(frames * 1000 / (now - tick)), delay: Math.round(delay) });
              if (quality === "auto" && delay > 350) onSaver();
              frames = 0; tick = now;
            }
          } finally { frame.close(); }
        },
        error() { if (!current(ws, attempt)) return; report?.("reconnect", "decoder_failed"); decodeFailed(); },
      });
      ws.onopen = () => {
        if (!current(ws, attempt)) return;
        opened = true; lastMessage = lastVideo = Date.now();
        clearTimeout(firstFrame);
        firstFrame = setTimeout(() => { if (current(ws, attempt) && !painted) stale(); }, FIRST_FRAME_WAIT_MS);
        ws.send(JSON.stringify({ type: "ping", time: Date.now() }));
      };
      ws.onmessage = event => {
        if (!current(ws, attempt)) return;
        lastMessage = Date.now();
        try {
          if (typeof event.data === "string") {
            const message = JSON.parse(event.data);
            if (message.type === "pong") {
              offset = message.server - (Date.now() + message.time) / 2; calibrated = true;
              if (Array.isArray(message.capabilities)) onCapabilities?.(message.capabilities.filter((name: unknown): name is string => typeof name === "string"));
              return;
            }
            if (message.type === "clipboard" && typeof message.text === "string") onClipboard?.({ text: message.text, at: Date.now() });
            return;
          }
          const packet = videoPacket(event.data);
          lastVideo = Date.now();
          if (packet.config) {
            config = new Uint8Array(packet.data);
            const decoderConfig = { codec: avcCodec(config), optimizeForLatency: true };
            void VideoDecoder.isConfigSupported(decoderConfig).then(result => {
              if (!result.supported && current(ws, attempt)) { report?.("reconnect", "decoder_failed"); decodeFailures = DECODE_LIMIT - 1; decodeFailed(); }
            }, () => {});
            try { decoder!.configure(decoderConfig); } catch { decodeFailed(); return; }
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
      ws.onclose = event => {
        if (!current(ws, attempt)) return;
        // The proxy classifies an upgrade failure against the codespace state and closes with 4001.
        // GitHub answers 401 on the forwarded port while a codespace shuts down; retrying or using
        // the tunnel cannot work then, so do not schedule a retry. Do not remove this check.
        if (event?.code === 4001) { report?.("reconnect", "phone_stopped"); stop(); transition("stopped"); return; }
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
    // A window change while the stream still delivers frames needs no reconnect.
    if (state === "streaming" && socket?.readyState === WebSocket.OPEN) return;
    if (performance.now() - lastResume < 250) return;
    lastResume = performance.now();
    acceptFramesAfter = lastResume;
    transition("connecting");
    report?.("presence");
    retry = 0;
    const ws = socket;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping", time: Date.now() }));
      // Keep the open socket. Reconnect only if no new frame arrives, for example on a static screen.
      clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => { void connect(); }, RESUME_FRAME_WAIT_MS);
    } else { void connect(); }
  };
  const visibility = () => {
    if (disposed()) return;
    if (!document.hidden) { resume(); return; }
    transition("suspended");
    report?.("presence", "hidden");
    clearTimeout(hiddenTimer);
    clearTimeout(resumeTimer);
    // Short absences keep the capture process and connection alive. Long ones free them.
    hiddenTimer = setTimeout(stop, HIDDEN_DISCONNECT_MS);
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
      if (!response.ok) {
        // A stopped phone never recovers on a timer; the page refresh shows its Wake control.
        if (await phoneStopped(response)) {
          enabled = false; clearInterval(presence); clearInterval(renewal); onState("stopped");
        }
        return;
      }
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
