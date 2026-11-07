"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { avcCodec, retryDelays, videoPacket } from "../lib/phone-video";

export function usePhoneVideo(id: string, live: boolean, quality: string, canvas: RefObject<HTMLCanvasElement | null>) {
  const socket = useRef<WebSocket | null>(null);
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);
  const [painted, setPainted] = useState(false);
  const [stats, setStats] = useState({ fps: 0, delay: 0 });
  const [saver, setSaver] = useState(false);
  useEffect(() => {
    setSupported("VideoDecoder" in window);
    if (!live || !("VideoDecoder" in window)) { setActive(false); return; }
    let disposed = false, retry = 0, timer: ReturnType<typeof setTimeout>, decoder: VideoDecoder | undefined;
    let calibrated = false;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let request: AbortController | undefined, frames = 0, tick = performance.now(), offset = 0, delay = 0;
    const sent = new Map<number, number>();
    const stop = () => {
      request?.abort(); clearTimeout(timer); clearInterval(watchdog);
      const ws = socket.current; socket.current = null;
      if (ws) { ws.onclose = null; ws.close(); }
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = undefined; sent.clear(); setActive(false);
    };
    async function connect() {
      if (disposed || document.hidden) return;
      stop();
      request = new AbortController();
      const attempt = request;
      try {
        const response = await fetch(`/app/phones/${encodeURIComponent(id)}/stream-ticket`, { method: "POST", signal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]) });
        if (!response.ok) throw new Error("Stream unavailable");
        const { ticket } = await response.json();
        if (disposed || document.hidden || attempt !== request || attempt.signal.aborted) return;
        const url = new URL(`/app/phones/${encodeURIComponent(id)}/stream`, location.href);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("ticket", ticket);
        url.searchParams.set("quality", quality === "auto" && saver ? "saver" : quality);
        const ws = new WebSocket(url); socket.current = ws; ws.binaryType = "arraybuffer";
        let config = new Uint8Array(), needKey = true, lastMessage = Date.now();
        watchdog = setInterval(() => { if (Date.now() - lastMessage > 15_000) ws.close(); }, 5000);
        decoder = new VideoDecoder({
          output(frame) {
            try {
              const element = canvas.current;
              if (!element || document.hidden) return;
              if (element.width !== frame.displayWidth || element.height !== frame.displayHeight) {
                element.width = frame.displayWidth; element.height = frame.displayHeight;
              }
              element.getContext("2d")?.drawImage(frame, 0, 0);
              delay = calibrated ? Math.max(0, Date.now() + offset - (sent.get(frame.timestamp) ?? Date.now())) : 0;
              sent.delete(frame.timestamp);
              setActive(true); setPainted(true); retry = 0; frames++;
              const now = performance.now();
              if (now - tick >= 1000) {
                setStats({ fps: Math.round(frames * 1000 / (now - tick)), delay: Math.round(delay) });
                if (quality === "auto" && delay > 350) setSaver(true);
                frames = 0; tick = now;
                ws.send(JSON.stringify({ type: "ping", time: Date.now() }));
              }
            } finally { frame.close(); }
          },
          error() { ws.close(); },
        });
        ws.onopen = () => ws.send(JSON.stringify({ type: "ping", time: Date.now() }));
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
            if (decoder!.decodeQueueSize > 5) { if (quality === "auto") setSaver(true); ws.close(); return; }
            let data = packet.data;
            if (packet.key) { data = new Uint8Array(config.length + packet.data.length); data.set(config); data.set(packet.data, config.length); }
            needKey = false; sent.set(packet.pts, packet.sent);
            if (sent.size > 120) { ws.close(); return; }
            decoder!.decode(new EncodedVideoChunk({ type: packet.key ? "key" : "delta", timestamp: packet.pts, data }));
          } catch { ws.close(); }
        };
        ws.onerror = () => ws.close();
        ws.onclose = () => {
          if (socket.current !== ws) return;
          stop();
          if (!disposed && !document.hidden) timer = setTimeout(connect, retryDelays[Math.min(retry++, 2)]);
        };
      } catch {
        if (!disposed && !document.hidden && attempt === request && !attempt.signal.aborted) timer = setTimeout(connect, retryDelays[Math.min(retry++, 2)]);
      }
    }
    const visibility = () => { if (document.hidden) stop(); else { retry = 0; void connect(); } };
    document.addEventListener("visibilitychange", visibility); void connect();
    return () => { disposed = true; stop(); document.removeEventListener("visibilitychange", visibility); };
  }, [id, live, quality, saver, canvas]);
  function send(input: Record<string, unknown>) {
    if (!live || !active || socket.current?.readyState !== WebSocket.OPEN) return false;
    socket.current.send(JSON.stringify(input)); return true;
  }
  return { supported, active, painted, stats, send };
}
