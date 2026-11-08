"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { avcCodec, retryDelays, videoPacket } from "../lib/phone-video";
import { phoneTiming } from "./phone-timing";

export function usePhoneVideo(id: string, live: boolean, quality: string, canvas: RefObject<HTMLCanvasElement | null>) {
  const socket = useRef<WebSocket | null>(null);
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);
  const [painted, setPainted] = useState(false);
  const [stats, setStats] = useState({ fps: 0, delay: 0 });
  const [saver, setSaver] = useState(false);
  const lastFrameAt = useRef(0);
  const reportFallback = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    setSupported("VideoDecoder" in window);
    if (!live) { setActive(false); return; }
    if (!("VideoDecoder" in window)) {
      setActive(false);
      // Screenshot-only browsers use the same authenticated attempt issuer,
      // without opening a video connection or changing keep-awake eligibility.
      const request = new AbortController();
      let report: ReturnType<typeof phoneTiming> | undefined, enabled = true;
      const issue = async () => {
        const started = performance.now();
        try {
          const response = await fetch(`/app/phones/${encodeURIComponent(id)}/stream-ticket`, { method: "POST", signal: request.signal });
          if (!response.ok) return;
          const { attemptId } = await response.json();
          if (request.signal.aborted) return;
          enabled = typeof attemptId === "string";
          report = phoneTiming(id, attemptId, started);
          reportFallback.current = () => report?.("screenshot_fallback");
          report("presence");
        } catch { /* Diagnostics cannot interrupt screenshot fallback. */ }
      };
      void issue();
      const presence = setInterval(() => report?.("presence"), 30000);
      const renewal = setInterval(() => { if (enabled) void issue(); }, 15 * 60000);
      const visibility = () => report?.("presence", document.hidden ? "hidden" : "none");
      document.addEventListener("visibilitychange", visibility);
      return () => {
        request.abort(); clearInterval(presence); clearInterval(renewal);
        reportFallback.current = undefined;
        document.removeEventListener("visibilitychange", visibility);
      };
    }
    let disposed = false, retry = 0, timer: ReturnType<typeof setTimeout>, decoder: VideoDecoder | undefined;
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
      const ws = socket.current; socket.current = null;
      if (ws) { ws.onclose = null; ws.close(); }
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = undefined; sent.clear(); setActive(false);
    };
    async function connect() {
      if (disposed || document.hidden) return;
      stop();
      calibrated = false; frames = 0; tick = performance.now();
      request = new AbortController();
      const attempt = request;
      const attemptStart = performance.now();
      try {
        const response = await fetch(`/app/phones/${encodeURIComponent(id)}/stream-ticket`, { method: "POST", signal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]) });
        if (!response.ok) throw new Error("Stream unavailable");
        const { ticket, attemptId } = await response.json();
        if (disposed || document.hidden || attempt !== request || attempt.signal.aborted) return;
        report = phoneTiming(id, attemptId, attemptStart);
        reportFallback.current = () => report?.("screenshot_fallback");
        report("presence");
        let issuedAt = performance.now(), renewing = false;
        presence = setInterval(() => {
          report?.("presence");
          if (!attemptId || renewing || performance.now() - issuedAt < 15 * 60000) return;
          renewing = true;
          const started = performance.now();
          void fetch(`/app/phones/${encodeURIComponent(id)}/stream-ticket`, { method: "POST", signal: attempt.signal })
            .then(async response => {
              if (!response.ok) return;
              const { attemptId: renewed } = await response.json();
              if (disposed || request !== attempt || attempt.signal.aborted) return;
              report = phoneTiming(id, renewed, started); issuedAt = started;
              report("presence");
            }).catch(() => {}).finally(() => { renewing = false; });
        }, 30000);
        const url = new URL(`/app/phones/${encodeURIComponent(id)}/stream`, location.href);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("ticket", ticket);
        url.searchParams.set("quality", quality === "auto" && saver ? "saver" : quality);
        const ws = new WebSocket(url); socket.current = ws; ws.binaryType = "arraybuffer";
        let config = new Uint8Array(), needKey = true, lastMessage = Date.now();
        watchdog = setInterval(() => {
          if (Date.now() - lastMessage > 15_000) { ws.close(); return; }
          // Heartbeats must continue even when Android's screen is static.
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", time: Date.now() }));
        }, 5000);
        let decoded = false, painted = false;
        decoder = new VideoDecoder({
          output(frame) {
            try {
              const element = canvas.current;
              if (!element || disposed || socket.current !== ws || attempt.signal.aborted) return;
              const timing = sent.get(frame.timestamp);
              if (!decoded) { decoded = true; report?.("first_decoded"); }
              sent.delete(frame.timestamp);
              if (document.hidden || !timing || timing.receivedAt < acceptFramesAfter) return;
              if (element.width !== frame.displayWidth || element.height !== frame.displayHeight) {
                element.width = frame.displayWidth; element.height = frame.displayHeight;
              }
              const drawing = element.getContext("2d");
              if (!drawing) return;
              drawing.drawImage(frame, 0, 0);
              if (!painted) {
                painted = true;
                // Two animation callbacks observe a rendering opportunity after canvas submission.
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  if (!disposed && socket.current === ws && !document.hidden) report?.("first_painted");
                }));
              }
              delay = calibrated ? Math.max(0, Date.now() + offset - timing.sent) : 0;
              lastFrameAt.current = performance.now();
              clearTimeout(resumeTimer);
              setActive(true); setPainted(true); retry = 0; frames++;
              const now = performance.now();
              if (now - tick >= 1000) {
                setStats({ fps: Math.round(frames * 1000 / (now - tick)), delay: Math.round(delay) });
                if (quality === "auto" && delay > 350) setSaver(true);
                frames = 0; tick = now;
              }
            } finally { frame.close(); }
          },
          error() { report?.("reconnect", "decoder_failed"); ws.close(); },
        });
        ws.onopen = () => { if (socket.current === ws) ws.send(JSON.stringify({ type: "ping", time: Date.now() })); };
        ws.onmessage = event => {
          if (socket.current !== ws) return;
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
            if (decoder!.decodeQueueSize > 5) { report?.("reconnect", "queue_full"); if (quality === "auto") setSaver(true); ws.close(); return; }
            let data = packet.data;
            if (packet.key) { data = new Uint8Array(config.length + packet.data.length); data.set(config); data.set(packet.data, config.length); }
            needKey = false; sent.set(packet.pts, { sent: packet.sent, receivedAt: performance.now() });
            if (sent.size > 120) { ws.close(); return; }
            decoder!.decode(new EncodedVideoChunk({ type: packet.key ? "key" : "delta", timestamp: packet.pts, data }));
          } catch { ws.close(); }
        };
        ws.onerror = () => ws.close();
        ws.onclose = () => {
          if (socket.current !== ws) return;
          report?.("reconnect", "socket_closed"); stop();
          if (!disposed && !document.hidden) timer = setTimeout(connect, retryDelays[Math.min(retry++, 2)]);
        };
      } catch {
        if (!disposed && !document.hidden && attempt === request && !attempt.signal.aborted) timer = setTimeout(connect, retryDelays[Math.min(retry++, 2)]);
      }
    }
    const resume = () => {
      if (document.hidden || disposed) return;
      clearTimeout(hiddenTimer);
      if (performance.now() - lastResume < 250) return;
      lastResume = performance.now();
      acceptFramesAfter = lastResume;
      setActive(false);
      report?.("presence");
      retry = 0;
      const ws = socket.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping", time: Date.now() }));
        // A static screen may not produce another frame. Reconnect for a fresh keyframe.
        clearTimeout(resumeTimer);
        resumeTimer = setTimeout(() => { void connect(); }, 2000);
      } else { void connect(); }
    };
    const visibility = () => {
      if (!document.hidden) { resume(); return; }
      setActive(false);
      report?.("presence", "hidden");
      clearTimeout(hiddenTimer);
      clearTimeout(resumeTimer);
      // Brief window switches keep the capture process and connection alive.
      hiddenTimer = setTimeout(stop, 3000);
    };
    document.addEventListener("visibilitychange", visibility); void connect();
    window.addEventListener("focus", resume);
    return () => {
      disposed = true; clearTimeout(hiddenTimer); stop();
      reportFallback.current = undefined;
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", resume);
    };
  }, [id, live, quality, saver, canvas]);
  function send(input: Record<string, unknown>) {
    if (!live || !active || socket.current?.readyState !== WebSocket.OPEN) return false;
    socket.current.send(JSON.stringify(input)); return true;
  }
  return { supported, active, painted, stats, send, lastFrameAt, reportFallback };
}
