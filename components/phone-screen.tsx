"use client";
import { useEffect, useRef, useState } from "react";
import { usePhoneVideo } from "./use-phone-video";
import { screenPoint, phoneKeys } from "../lib/phone-video";
import { Button } from "./button";
import s from "./console.module.css";

export function PhoneScreen({ id, live, resting }: { id: string; live: boolean; resting: boolean }) {
  const [frame, setFrame] = useState("");
  const [error, setError] = useState("");
  const [inputPending, setInputPending] = useState(false);
  const [quality, setQuality] = useState("auto");
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = usePhoneVideo(id, live, quality, canvas);
  const stage = useRef<HTMLDivElement>(null);
  const pressed = useRef(new Set<string>());
  const pointers = useRef(new Map<number, number>());
  const activeVideo = useRef(false);
  activeVideo.current = video.active;
  const image = useRef<HTMLImageElement>(null);
  const inputBusy = useRef(false);
  useEffect(() => { if (!video.active) { pointers.current.clear(); pressed.current.clear(); } }, [video.active]);
  const endpoint = `/app/phones/${encodeURIComponent(id)}/screen.png`;
  useEffect(() => {
    let disposed = false;
    let busy = false;
    let current = "";
    let controller: AbortController | undefined;
    async function poll() {
      if (!live || activeVideo.current || disposed || busy || document.visibilityState !== "visible") return;
      busy = true;
      controller = new AbortController();
      try {
        const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Screen unavailable. Retrying…");
        const blob = await response.blob();
        const next = URL.createObjectURL(blob);
        const decoded = new Image();
        decoded.src = next;
        try { await decoded.decode(); }
        catch (error) { URL.revokeObjectURL(next); throw error; }
        if (disposed || document.visibilityState !== "visible") { URL.revokeObjectURL(next); return; }
        const previous = current;
        current = next;
        setFrame(next);
        setError("");
        URL.revokeObjectURL(previous);
      } catch {
        if (!disposed && !controller.signal.aborted) setError("Screen unavailable. Retrying…");
      } finally { busy = false; }
    }
    const visibility = () => { if (document.hidden) controller?.abort(); else void poll(); };
    const timer = setInterval(() => { void poll(); }, 1000);
    document.addEventListener("visibilitychange", visibility);
    void poll();
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      // Keep the displayed frame when live changes. Release it after the replacement loads or unmounts.
    };
  }, [endpoint, live]);
  const lastFrame = useRef("");
  useEffect(() => {
    if (lastFrame.current && lastFrame.current !== frame) URL.revokeObjectURL(lastFrame.current);
    lastFrame.current = frame;
  }, [frame]);
  useEffect(() => () => { URL.revokeObjectURL(lastFrame.current); }, []);

  async function input(body: Record<string, unknown>) {
    if (!live || inputBusy.current) return;
    inputBusy.current = true;
    setInputPending(true);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error("Input failed");
      setError("");
    } catch { setError("Phone input failed. Try again."); }
    finally { inputBusy.current = false; setInputPending(false); }
  }
  function position(event: { clientX: number; clientY: number }) {
    const element = video.active ? canvas.current : image.current;
    if (!element) return;
    const width = video.active ? canvas.current!.width : image.current!.naturalWidth;
    const height = video.active ? canvas.current!.height : image.current!.naturalHeight;
    return screenPoint(event.clientX, event.clientY, element.getBoundingClientRect(), width, height);
  }
  const wheel = useRef<(event: WheelEvent) => void>(() => {});
  wheel.current = event => {
    const point = position(event);
    if (!point || !video.active) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 3 : event.deltaMode === 2 ? 1 / 16 : 100;
    video.send({ type: "wheel", ...point, dx: Math.max(-16, Math.min(16, -event.deltaX / unit)),
      dy: Math.max(-16, Math.min(16, -event.deltaY / unit)) });
  };
  useEffect(() => {
    const element = stage.current;
    const handler = (event: WheelEvent) => wheel.current(event);
    element?.addEventListener("wheel", handler, { passive: false });
    return () => element?.removeEventListener("wheel", handler);
  }, []);
  const showCanvas = video.painted && (video.active || !live || !frame);
  return <div className={s.screenPanel}>
    <div ref={stage} className={`${s.screenTouch} ${!live || (video.supported && !video.active) || !!error ? s.screenDim : ""}`}
      role="application" tabIndex={live ? 0 : -1} aria-label="Phone screen. Focus to use keyboard and paste."
      onPointerDown={event => {
        event.currentTarget.focus();
        const point = position(event);
        if (!point || !live) return;
        if (!video.active) { void input({ type: "tap", x: point.x, y: point.y }); return; }
        if (pointers.current.size >= 10) return;
        const used = new Set(pointers.current.values());
        const pointer = Array.from({ length: 10 }, (_, i) => i).find(i => !used.has(i))!;
        pointers.current.set(event.pointerId, pointer);
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault(); video.send({ type: "touch", action: "down", pointer, ...point });
      }} onPointerMove={event => {
        const pointer = pointers.current.get(event.pointerId), point = position(event);
        if (pointer !== undefined && point) video.send({ type: "touch", action: "move", pointer, ...point });
      }} onPointerUp={event => {
        const pointer = pointers.current.get(event.pointerId), point = position(event);
        if (pointer !== undefined && point) video.send({ type: "touch", action: "up", pointer, ...point });
        pointers.current.delete(event.pointerId);
      }} onPointerCancel={event => {
        const pointer = pointers.current.get(event.pointerId), point = position(event);
        if (pointer !== undefined && point) video.send({ type: "touch", action: "cancel", pointer, ...point });
        pointers.current.delete(event.pointerId);
      }} onKeyDown={event => {
        if (!video.active || event.nativeEvent.isComposing || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v")) return;
        const meta = (event.shiftKey ? 1 : 0) | (event.altKey ? 2 : 0) | (event.ctrlKey ? 4096 : 0) | (event.metaKey ? 65536 : 0);
        const key = (event.ctrlKey || event.metaKey || event.altKey) && /^(Key[A-Z]|Digit[0-9])$/.test(event.code) ? event.code : event.key;
        if (phoneKeys.has(key) || /^(Key[A-Z]|Digit[0-9])$/.test(key)) {
          event.preventDefault(); pressed.current.add(key); video.send({ type: "key", key, action: "down", meta });
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault(); video.send({ type: "text", text: event.key });
        }
      }} onKeyUp={event => {
        const key = pressed.current.has(event.code) ? event.code : event.key;
        if (video.active && pressed.current.has(key)) {
          event.preventDefault(); pressed.current.delete(key); video.send({ type: "key", key, action: "up" });
        }
      }} onPaste={event => {
        if (!video.active) return;
        event.preventDefault(); const text = event.clipboardData.getData("text/plain");
        if (text) video.send({ type: "paste", text: text.slice(0, 2000) });
      }} onCompositionEnd={event => { if (event.data) video.send({ type: "paste", text: event.data }); }}
      onBlur={() => {
        for (const key of pressed.current) video.send({ type: "key", key, action: "up" });
        pressed.current.clear();
        for (const pointer of pointers.current.values()) video.send({ type: "touch", action: "cancel", pointer, x: 0, y: 0,
          width: canvas.current?.width ?? 1, height: canvas.current?.height ?? 1 });
        pointers.current.clear();
      }}>
      <canvas ref={canvas} className={s.screenImage} style={{ display: showCanvas ? "block" : "none" }} aria-label="Live Android screen" />
      {frame && <img ref={image} src={frame} alt="Android screen" className={s.screenImage} style={{ display: showCanvas ? "none" : "block" }} />}
      {!frame && !video.painted && <div className={s.screenPlaceholder}>{live ? "Connecting to the screen..." : resting ? "Resting" : "Waiting for Android..."}</div>}
    </div>
    <div className={s.screenControls}>
      {([ ["home", "Home"], ["back", "Back"], ["recent", "Recent apps"], ["rotate", "Rotate"],
        ["volumeUp", "Volume up"], ["volumeDown", "Volume down"] ] as const).map(([key, label]) =>
        <Button key={key} tiny variant="ghost" disabled={!live || inputPending || (!video.active && !["home", "back"].includes(key))}
          onClick={() => { if (!video.send(key === "rotate" ? { type: "rotate" } : { type: "key", key })) void input({ type: "key", key }); }}>{label}</Button>)}
      <Button tiny variant="ghost" disabled={!frame && !video.painted} onClick={async () => {
        const blob = video.painted && showCanvas ? await new Promise<Blob | null>(resolve => canvas.current!.toBlob(resolve, "image/png")) : null;
        const url = blob ? URL.createObjectURL(blob) : frame;
        const link = document.createElement("a"); link.href = url; link.download = `${id}.png`; link.click();
        if (blob) setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}>Screenshot</Button>
    </div>
    <fieldset className={s.qualityPicker}>
      <legend>Stream quality</legend>
      <div className={s.qualityOptions}>
        {([
          ["auto", "Auto", "Adapts to connection"],
          ["sharp", "Sharp", "1080p"],
          ["saver", "Saver", "720p · 15 fps"],
        ] as const).map(([value, label, detail]) => <label key={value} className={s.qualityOption}>
          <input type="radio" name={`quality-${id}`} value={value} checked={quality === value}
            onChange={() => setQuality(value)} />
          <span><strong>{label}</strong><small>{detail}</small></span>
        </label>)}
      </div>
    </fieldset>
    <p role="status">{!live ? resting ? "Resting" : "Waiting for Android..." : !video.supported ? "Screenshot view" : video.active ? `${video.stats.fps} fps / ${video.stats.delay} ms delay` : frame || video.painted ? "Reconnecting... / screenshot view" : "Connecting..."}</p>
    {error && live && !video.active && <p role="status">{error}</p>}
  </div>;

}

export function AndroidElapsed({ started }: { started: string | null }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = now && started ? Math.max(0, Math.floor((now - Date.parse(started)) / 1000)) : 0;
  return <p>Starting Android… {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} elapsed</p>;
}
