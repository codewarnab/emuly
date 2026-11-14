"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPhoneVideoConnection } from "./phone-video-connection";

export function usePhoneVideo(id: string, live: boolean, quality: string, canvas: RefObject<HTMLCanvasElement | null>) {
  const connection = useRef<ReturnType<typeof createPhoneVideoConnection> | null>(null);
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [painted, setPainted] = useState(false);
  const [stats, setStats] = useState({ fps: 0, delay: 0 });
  const [saver, setSaver] = useState(false);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [clipboard, setClipboard] = useState<{ text: string; at: number } | null>(null);
  const lastFrameAt = useRef(0);
  const reportFallback = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    setSupported("VideoDecoder" in window);
    if (!live) { setActive(false); setStopped(false); return; }
    const session = createPhoneVideoConnection({
      id, quality: quality === "auto" && saver ? "saver" : quality,
      onState: state => { if (state === "fallback") setSupported(false); setActive(state === "streaming"); setStopped(state === "stopped"); },
      onStats: setStats,
      onCapabilities: setCapabilities,
      onClipboard: setClipboard,
      onSaver: () => setSaver(true),
      onFrame(frame) {
        const element = canvas.current;
        if (!element) return false;
        if (element.width !== frame.displayWidth || element.height !== frame.displayHeight) {
          element.width = frame.displayWidth; element.height = frame.displayHeight;
        }
        const drawing = element.getContext("2d");
        if (!drawing) return false;
        drawing.drawImage(frame, 0, 0);
        lastFrameAt.current = performance.now(); setPainted(true);
        return true;
      },
    });
    connection.current = session; reportFallback.current = session.reportFallback;
    return () => {
      session.dispose(); connection.current = null; reportFallback.current = undefined;
    };
  }, [id, live, quality, saver, canvas]);
  function send(input: Record<string, unknown>) {
    return connection.current?.send(input) ?? false;
  }
  return { supported, active, stopped, painted, stats, send, lastFrameAt, reportFallback, capabilities, clipboard,
    clearClipboard: () => setClipboard(null) };
}
