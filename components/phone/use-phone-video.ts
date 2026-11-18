"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPhoneVideoConnection } from "./phone-video-connection";
import { createBrowserRecording } from "./phone-recording";

export function usePhoneVideo(id: string, live: boolean, quality: string, canvas: RefObject<HTMLCanvasElement | null>) {
  const connection = useRef<ReturnType<typeof createPhoneVideoConnection> | null>(null);
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [painted, setPainted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stats, setStats] = useState({ fps: 0, delay: 0 });
  const [saver, setSaver] = useState(false);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [clipboard, setClipboard] = useState<{ text: string; at: number } | null>(null);
  const lastFrameAt = useRef(0);
  const recording = useRef<ReturnType<typeof createBrowserRecording> | null>(null);
  const [recordingSince, setRecordingSince] = useState<number | null>(null);
  const [recordingFull, setRecordingFull] = useState(false);
  const reportFallback = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    setSupported("VideoDecoder" in window);
    if (!live) { setActive(false); setStopped(false); setStarting(false); return; }
    const session = createPhoneVideoConnection({
      id, quality: quality === "auto" && saver ? "saver" : quality,
      onState: state => { setStarting(false); if (state === "fallback") setSupported(false); setActive(state === "streaming"); setStopped(state === "stopped"); },
      onStats: setStats,
      onCapabilities: setCapabilities,
      onClipboard: setClipboard,
      onSaver: () => setSaver(true),
      onOpen: () => setStarting(true),
      onPacket(packet) { if (recording.current?.add(packet)) setRecordingFull(true); },
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
  function startRecording() {
    recording.current = createBrowserRecording();
    setRecordingFull(false); setRecordingSince(recording.current.startedAt);
    // A static screen sends no frames, and the next keyframe can be seconds away. Ask for one now,
    // and wake the screen so the encoder sends it (see the wakeup note in scrcpy-hub.mjs).
    send({ type: "keyframe" });
    send({ type: "key", key: "wakeup" });
  }
  /** Ends the recording and returns the MP4, or null when no frame arrived. */
  function stopRecording() {
    const blob = recording.current?.finish() ?? null;
    recording.current = null; setRecordingSince(null); setRecordingFull(false);
    return blob;
  }
  return { supported, active, stopped, painted, starting, stats, send, lastFrameAt, reportFallback, capabilities, clipboard,
    recordingSince, recordingFull, startRecording, stopRecording,
    clearClipboard: () => setClipboard(null) };
}
