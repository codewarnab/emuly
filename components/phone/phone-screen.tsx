"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePhoneVideo } from "@/components/phone/use-phone-video";
import { AgentOverlay } from "@/components/phone/agent-overlay";
import { pngConnection } from "@/components/phone/png-connection";
import { screenPoint, phoneKeys } from "@/lib/phone/phone-video";
import { copyText, useToast } from "@/components/ui/ui-provider";
import { Button } from "@/components/ui/button";
import s from "@/components/phone/phone-screen.module.css";
import type { StreamQuality } from "@/lib/shared/display-settings";

const controlIcons = {
  back: <path d="m14 6-6 6 6 6" />,
  home: <circle cx="12" cy="12" r="6" />,
  recent: <rect x="6" y="6" width="12" height="12" rx="2" />,
  clipboard: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  volumeUp: <><path d="M11 5 6 9H3v6h3l5 4zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" /></>,
  volumeDown: <><path d="M11 5 6 9H3v6h3l5 4zM16 12h5" /></>,
  desktop: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  screenshot: <><path d="m8 5 1-2h6l1 2h4v15H4V5z" /><circle cx="12" cy="12" r="4" /></>,
};

type DesktopOs = "windows" | "mac" | "linux";
const osLogos: Record<DesktopOs, { label: string; icon: React.ReactNode }> = {
  windows: { label: "Windows", icon: <path d="M3 5.5 10.5 4.5v7H3zM11.5 4.4 21 3v8.5h-9.5zM3 12.5h7.5v7L3 18.5zM11.5 12.5H21V21l-9.5-1.4z" /> },
  mac: { label: "macOS", icon: <><path d="M16.4 12.6c0-2.3 1.9-3.4 2-3.5a4.3 4.3 0 0 0-3.4-1.8c-1.4-.1-2.8.9-3.5.9s-1.9-.8-3.1-.8A4.6 4.6 0 0 0 4.5 9.8c-1.7 2.9-.4 7.2 1.2 9.6.8 1.2 1.7 2.5 3 2.4 1.2 0 1.6-.8 3.1-.8s1.8.8 3.1.8 2.1-1.2 2.9-2.4a10 10 0 0 0 1.3-2.7 4.1 4.1 0 0 1-2.7-4.1z" /><path d="M14.1 5.6A4 4 0 0 0 15 2.7a4.1 4.1 0 0 0-2.7 1.4 3.8 3.8 0 0 0-1 2.8 3.4 3.4 0 0 0 2.8-1.3z" /></> },
  linux: { label: "Linux", icon: <><path d="M12 2c-2.2 0-3.6 1.8-3.6 4.4 0 1.3-.3 2.2-1.2 3.4C5.8 11.6 5 13.6 5 15.6c0 .7.1 1.3.3 1.9-.8.4-1.8.9-1.8 1.7 0 1.2 2.4 1.3 3.3 2.2.7.7 1.4.8 2.2.4.6-.3 1.6-.4 3-.4s2.4.1 3 .4c.8.4 1.5.3 2.2-.4.9-.9 3.3-1 3.3-2.2 0-.8-1-1.3-1.8-1.7.2-.6.3-1.2.3-1.9 0-2-.8-4-2.2-5.8-.9-1.2-1.2-2.1-1.2-3.4C15.6 3.8 14.2 2 12 2z" /><circle cx="10.5" cy="6.5" r=".9" fill="var(--panel2)" /><circle cx="13.5" cy="6.5" r=".9" fill="var(--panel2)" /><path d="M10.8 8.3h2.4L12 9.6z" fill="#e8a33d" /></> },
};

function ControlIcon({ name }: { name: keyof typeof controlIcons }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{controlIcons[name]}</svg>;
}

export function PhoneScreen({ id, live, resting, quality = "auto" }: { id: string; live: boolean; resting: boolean; quality?: StreamQuality }) {
  const [frame, setFrame] = useState("");
  const [screenshotFresh, setScreenshotFresh] = useState(false);
  const [screenshotAt, setScreenshotAt] = useState(0);
  const [error, setError] = useState("");
  const [inputPending, setInputPending] = useState(false);
  const [lastAgentAt, setLastAgentAt] = useState(0);
  const [agentNow, setAgentNow] = useState(0);
  const notify = useToast();
  const [clipboardPending, setClipboardPending] = useState(false);
  const [clipboardEmpty, setClipboardEmpty] = useState(false);
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [desktopOs, setDesktopOs] = useState<DesktopOs>("windows");
  const [origin, setOrigin] = useState("https://emuly.vercel.app");
  useEffect(() => {
    // userAgentData is newer and exact (Chromium); the user agent string covers Safari and Firefox.
    const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.userAgent;
    setOrigin(window.location.origin);
    setDesktopOs(/win/i.test(platform) ? "windows" : /mac|iphone|ipad/i.test(platform) ? "mac" : "linux");
  }, []);
  const desktopCommand = desktopOs === "windows"
    ? `powershell -ExecutionPolicy Bypass -c "irm ${origin}/open/${id}.ps1 | iex"`
    : `curl -fsSL ${origin}/open/${id}.sh | sh`;
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = usePhoneVideo(id, live, quality, canvas);
  const router = useRouter();
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
    let generation = 0;
    let lastResume = -Infinity;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let streamController = new AbortController();
    let nextFrame = pngConnection(id, streamController.signal);
    let lastHttp = -Infinity;
    async function poll() {
      if (!live || video.stopped || activeVideo.current || disposed || controller || document.visibilityState !== "visible") return;
      const attempt = new AbortController();
      controller = attempt;
      const epoch = generation;
      const started = performance.now();
      let next = "";
      try {
        let blob: Blob;
        try { blob = await nextFrame(); }
        catch {
          attempt.signal.throwIfAborted();
          if (performance.now() - lastHttp < 5000) return;
          lastHttp = performance.now();
          const response = await fetch(endpoint, { cache: "no-store",
            signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(15_000)]) });
          if (!response.ok) throw new Error("Screen unavailable");
          blob = await response.blob();
        }
        next = URL.createObjectURL(blob);
        const decoded = new Image();
        decoded.src = next;
        await decoded.decode();
        if (disposed || attempt.signal.aborted || epoch !== generation || document.hidden ||
          activeVideo.current || started <= video.lastFrameAt.current) return;
        setFrame(next);
        video.reportFallback.current?.();
        next = "";
        setScreenshotAt(started);
        setScreenshotFresh(true);
        clearTimeout(expiry);
        expiry = setTimeout(() => setScreenshotFresh(false), 5000);
        setError("");
      } catch {
        if (!disposed && epoch === generation && !attempt.signal.aborted) setError("Screen unavailable. Retrying…");
      } finally {
        if (next) URL.revokeObjectURL(next);
        if (controller === attempt) controller = undefined;
      }
    }
    const invalidate = () => {
      generation++;
      controller?.abort();
      controller = undefined;
      streamController.abort();
      streamController = new AbortController();
      nextFrame = pngConnection(id, streamController.signal);
      clearTimeout(expiry);
      setScreenshotFresh(false);
    };
    const resume = () => {
      if (document.hidden || performance.now() - lastResume < 250) return;
      lastResume = performance.now();
      invalidate();
      void poll();
    };
    const visibility = () => { if (document.hidden) invalidate(); else resume(); };
    const timer = setInterval(() => { void poll(); }, 1000);
    document.addEventListener("visibilitychange", visibility);
    // A window change with the tab still visible keeps the current PNG stream.
    const focus = () => { void poll(); };
    window.addEventListener("focus", focus);
    void poll();
    return () => {
      disposed = true;
      invalidate();
      streamController.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
      // Keep the displayed frame when live changes. Release it after the replacement loads or unmounts.
    };
  }, [endpoint, id, live, video.stopped, video.active, video.lastFrameAt]);
  const lastFrame = useRef("");
  // Reuse the page's existing server-rendered stopped state and Wake control. The page only renders
  // PhoneScreen while the phone is running, so refreshing here replaces the old image with "Phone stopped".
  useEffect(() => { if (video.stopped) router.refresh(); }, [video.stopped, router]);
  useEffect(() => {
    if (lastFrame.current && lastFrame.current !== frame) URL.revokeObjectURL(lastFrame.current);
    lastFrame.current = frame;
  }, [frame]);
  useEffect(() => () => { URL.revokeObjectURL(lastFrame.current); }, []);
  useEffect(() => {
    if (!video.clipboard) return;
    setClipboardPending(false);
    setClipboardEmpty(false);
  }, [video.clipboard]);
  useEffect(() => {
    if (!clipboardPending) return;
    const timer = setTimeout(() => { setClipboardPending(false); setClipboardEmpty(true); }, 4000);
    return () => clearTimeout(timer);
  }, [clipboardPending]);
  useEffect(() => {
    if (!lastAgentAt) return;
    const ticker = setInterval(() => setAgentNow(Date.now()), 1000);
    const stop = setTimeout(() => { setAgentNow(lastAgentAt + 10_000); clearInterval(ticker); }, 10_000);
    return () => { clearInterval(ticker); clearTimeout(stop); };
  }, [lastAgentAt]);

  async function input(body: Record<string, unknown>) {
    if (!live || (!video.active && !screenshotFresh) || inputBusy.current) return;
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
    const element = showCanvas ? canvas.current : image.current;
    if (!element) return;
    const width = showCanvas ? canvas.current!.width : image.current!.naturalWidth;
    const height = showCanvas ? canvas.current!.height : image.current!.naturalHeight;
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
  const showCanvas = video.painted && (video.active || !frame || video.lastFrameAt.current >= screenshotAt);
  const fresh = live && !video.stopped && (video.active || screenshotFresh);
  const reconnecting = live && !video.stopped && !fresh;
  const connectionLabel = video.stopped ? "Phone stopped" : !live ? resting ? "Resting" : "Waiting for Android"
    : video.active ? "Live" : screenshotFresh ? "Screenshot view" : frame || video.painted ? "Reconnecting · showing last image" : "Connecting";
  const agentAgo = lastAgentAt && agentNow ? Math.max(0, Math.floor((agentNow - lastAgentAt) / 1000)) : 0;
  const agentWorking = lastAgentAt > 0 && agentNow > 0 && agentNow - lastAgentAt < 10_000;
  function control(key: "home" | "back" | "recent" | "volumeUp" | "volumeDown", label: string) {
    return <button type="button" className={s.control} aria-label={label} title={label}
      disabled={!fresh || inputPending || (!video.active && !["home", "back"].includes(key))}
      onClick={() => { if (!video.send({ type: "key", key })) void input({ type: "key", key }); }}>
      <ControlIcon name={key} /><span className={s.tooltip}>{label}</span>
    </button>;
  }
  function readClipboard(copyKey: 0 | 1) {
    if (!video.active) return;
    video.clearClipboard();
    setClipboardEmpty(false);
    setClipboardPending(true);
    if (!video.send({ type: "get-clipboard", copyKey })) { setClipboardPending(false); setClipboardEmpty(true); }
  }
  function closeClipboard() {
    video.clearClipboard();
    setClipboardPending(false);
    setClipboardEmpty(false);
  }
  const clipboardCapable = video.active && video.capabilities.includes("clipboard");
  const phoneClipboard = video.clipboard;
  const clipboardOpen = Boolean(phoneClipboard || clipboardPending || clipboardEmpty);

  // One-time hint: after 45 s of live video in a visible tab, point at "Open on your computer".
  // Desktop only, since phones cannot run scrcpy. Closing it (or opening the popover) hides it for good in this browser.
  const [hint, setHint] = useState<"waiting" | "shown" | "done">("waiting");
  const hintRef = useRef<HTMLDivElement>(null);
  const watching = video.active && video.painted && !desktopOpen && !clipboardOpen;
  useEffect(() => {
    if (hint !== "waiting") return;
    try { if (localStorage.getItem("emuly.hint.scrcpy")) { setHint("done"); return; } } catch {}
    if (/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || !matchMedia("(pointer: fine)").matches) { setHint("done"); return; }
    if (!watching) return;
    let seen = 0;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      seen += 1;
      if (seen >= 45) { clearInterval(timer); setHint("shown"); }
    }, 1000);
    return () => clearInterval(timer);
  }, [hint, watching]);
  function endHint(forever: boolean) {
    setHint("done");
    if (!forever) return;
    // This browser only: a hint is not worth a database row.
    try { localStorage.setItem("emuly.hint.scrcpy", "1"); } catch {}
  }
  useEffect(() => {
    if (hint !== "shown") return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") endHint(true); };
    // A click elsewhere hides it on this page only; it may come back on a later visit.
    const onDown = (event: PointerEvent) => { if (!hintRef.current?.contains(event.target as Node)) endHint(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onDown); };
  }, [hint]);
  return <div className={s.screenPanel}>
    <header className={s.header}>
      <h2>Live screen</h2>
      <span className={s.connection} data-live={live && video.active} role="status"><i aria-hidden="true" />{connectionLabel}</span>
    </header>
    <div className={s.viewer}>
    <div className={s.display}>
    <div ref={stage} className={`${s.screenTouch} ${!live || video.stopped ? s.screenDim : ""}`}
      role="application" tabIndex={fresh ? 0 : -1} aria-label="Phone screen. Focus to use keyboard and paste."
      onPointerDown={event => {
        event.currentTarget.focus();
        const point = position(event);
        if (!point || !fresh) return;
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
      {!frame && !video.painted && <div className={s.screenPlaceholder}>{video.stopped ? "Phone stopped" : live ? "Connecting to the screen..." : resting ? "Resting" : "Waiting for Android..."}</div>}
      <AgentOverlay id={id} live={live} delayMs={video.active ? video.stats.delay : 0}
        onActivity={at => { setLastAgentAt(at); setAgentNow(at); }} />
    </div>
    <div className={s.navigation} role="group" aria-label="Android navigation">
      {control("back", "Back")}{control("home", "Home")}{control("recent", "Recent apps")}
    </div>
    </div>
    <div className={s.tools} role="group" aria-label="Device tools">
      {control("volumeUp", "Volume up")}{control("volumeDown", "Volume down")}
      <span className={s.divider} />
      <div className={s.clipboardAnchor}>
        <button type="button" className={s.control} aria-label="Copy from phone"
          title={clipboardCapable ? "Copy from phone" : "Update the phone runner to copy from the phone"}
          disabled={!fresh || !clipboardCapable} onClick={() => readClipboard(0)}>
          <ControlIcon name="clipboard" /><span className={s.tooltip}>Copy from phone</span>
        </button>
        {(phoneClipboard || clipboardPending || clipboardEmpty) && <div className={s.clipboardPanel} role="status">
          <div className={s.clipboardHead}>
            <span>Phone clipboard</span>
            <button type="button" className={s.clipboardClose} aria-label="Close clipboard" onClick={closeClipboard}>×</button>
          </div>
          {phoneClipboard
            ? <textarea readOnly value={phoneClipboard.text} aria-label="Text copied from the phone" onFocus={event => event.currentTarget.select()} />
            : <p className={s.clipboardHint}>{clipboardPending ? "Reading the phone clipboard…" : "Nothing on the phone clipboard. Select text in an app, press Copy, then try again."}</p>}
          <div className={s.clipboardActions}>
            {phoneClipboard && <Button type="button" tiny variant="ghost"
              onClick={() => { if (phoneClipboard) void copyText(phoneClipboard.text, notify, "Copied from the phone"); }}>Copy to computer</Button>}
            <Button type="button" tiny variant="ghost" disabled={!video.active} onClick={() => readClipboard(1)}>Copy selected text</Button>
          </div>
        </div>}
      </div>
      {/* Placeholder: the scripts behind these commands are not built yet. */}
      <div className={s.clipboardAnchor}>
        <button type="button" className={`${s.control} ${hint === "shown" ? s.pulse : ""}`} aria-label="Open on your computer" aria-expanded={desktopOpen}
          onClick={() => { if (hint !== "done") endHint(true); setDesktopOpen(open => !open); }}>
          <ControlIcon name="desktop" /><span className={s.tooltip}>Open on your computer</span>
        </button>
        {hint === "shown" && !desktopOpen && <div ref={hintRef} className={`${s.clipboardPanel} ${s.hintPanel}`} role="status" aria-live="polite">
          <div className={s.clipboardHead}>
            <span>Try it in its own window</span>
            <button type="button" className={s.clipboardClose} aria-label="Close and do not show again" onClick={() => endHint(true)}>×</button>
          </div>
          <p className={s.clipboardHint}>Faster video, straight from your codespace.</p>
          <div className={s.hintActions}>
            <Button type="button" tiny onClick={() => { endHint(true); setDesktopOpen(true); }}>Show me</Button>
          </div>
        </div>}
        {desktopOpen && <div className={`${s.clipboardPanel} ${s.desktopPanel}`} role="dialog" aria-label="Open on your computer">
          <div className={s.clipboardHead}>
            <span>Open in its own window</span>
            <button type="button" className={s.clipboardClose} aria-label="Close" onClick={() => setDesktopOpen(false)}>×</button>
          </div>
          <p className={s.clipboardHint}>Recommended: faster video, straight from your codespace.</p>
          <div className={s.osTabs} role="tablist" aria-label="Your system">
            {(Object.keys(osLogos) as DesktopOs[]).map(os => <button key={os} type="button" role="tab" aria-selected={desktopOs === os}
              aria-label={osLogos[os].label} title={osLogos[os].label} className={s.osTab} onClick={() => setDesktopOs(os)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{osLogos[os].icon}</svg></button>)}
          </div>
          <div className={s.command}>
            <code>{desktopCommand}</code>
            <button type="button" className={s.commandCopy} aria-label="Copy command"
              onClick={() => void copyText(desktopCommand, notify, "Command copied")}><ControlIcon name="clipboard" /></button>
          </div>
        </div>}
      </div>
      <button type="button" className={s.control} aria-label="Screenshot" title="Screenshot" disabled={!frame && !video.painted} onClick={async () => {
        const blob = video.painted && showCanvas ? await new Promise<Blob | null>(resolve => canvas.current!.toBlob(resolve, "image/png")) : null;
        const url = blob ? URL.createObjectURL(blob) : frame;
        const link = document.createElement("a"); link.href = url; link.download = `${id}.png`; link.click();
        if (blob) setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}><ControlIcon name="screenshot" /><span className={s.tooltip}>Screenshot</span></button>
    </div>
    </div>
    <footer className={s.footer}>
      <span>{video.stopped ? "The phone stopped. Wake it to resume this device." : reconnecting ? "Controls resume when a fresh image arrives" : video.active ? "Click to control · Type to send text" : "Click the screen to tap"}</span>
      {agentWorking && <span className={s.agentStatus}>Agent is working · last action {agentAgo}s ago</span>}
      <span role="status">{video.active ? `${video.stats.fps} fps · ${video.stats.delay} ms` : video.stopped ? "Phone stopped" : live && video.supported ? "Reconnecting…" : ""}</span>
    </footer>
    {error && live && !video.stopped && !video.active && <p className={s.error} role="status">{error}</p>}
  </div>;

}

/** Live count-up for the stage in progress, so a watcher can see the phone is still working. */
export function AndroidElapsed({ started }: { started: string | null }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const startedAt = Date.parse(started ?? "");
  if (now === null || !Number.isFinite(startedAt)) return <p>Waiting for the screen to become ready.</p>;
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return <p role="timer" aria-live="off">This step has run for {Math.floor(seconds / 60)} min {String(seconds % 60).padStart(2, "0")} sec</p>;
}
