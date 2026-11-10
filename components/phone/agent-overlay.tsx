"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import s from "@/components/phone/phone-screen.module.css";
import type { AgentAction } from "@/lib/phone/agent-action";

type Display = { width: number; height: number };
type Feed = { display: Display | null; actions: { id: number; at: string; action: AgentAction }[] };
type Mark = { key: number; action: AgentAction; display: Display | null };
type Size = { w: number; h: number };

function chipText(action: AgentAction): string {
  switch (action.type) {
    case "text": return "Typing";
    case "key":
      return action.key === "back" ? "Back" : action.key === "home" ? "Home" : action.key === "recent" ? "Recent" : "Key press";
    case "command": return action.label;
    case "tap": return "Tap";
    case "swipe": return "Swipe";
  }
}

/** Tap and swipe draw on the phone, so they are not chip marks. */
function isFinger(mark: Mark): boolean {
  return mark.display !== null && (mark.action.type === "tap" || mark.action.type === "swipe");
}

export function AgentOverlay({ id, live, delayMs, onActivity }: {
  id: string; live: boolean; delayMs: number; onActivity?: (at: number) => void;
}) {
  const [marks, setMarks] = useState<Mark[]>([]);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const layer = useRef<HTMLDivElement>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const nextKey = useRef(0);
  const activity = useRef(onActivity);
  activity.current = onActivity;
  const delay = useRef(delayMs);
  delay.current = delayMs;

  useEffect(() => {
    const node = layer.current;
    if (!node) return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setSize(current =>
        current.w === rect.width && current.h === rect.height
          ? current
          : { w: rect.width, h: rect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active) clearTimeout(timer);
      active.clear();
    };
  }, []);

  useEffect(() => {
    if (!live) return;
    let source: EventSource | undefined;

    const schedule = (fn: () => void, ms: number) => {
      const timer = setTimeout(() => { timers.current.delete(timer); fn(); }, ms);
      timers.current.add(timer);
    };

    const open = () => {
      if (source || document.visibilityState !== "visible") return;
      source = new EventSource(`/app/phones/${encodeURIComponent(id)}/actions`);
      source.onmessage = event => {
        let feed: Feed;
        try { feed = JSON.parse(event.data) as Feed; } catch { return; }
        if (!feed || !Array.isArray(feed.actions)) return;
        for (const item of feed.actions) {
          schedule(() => {
            activity.current?.(Date.now());
            const mark: Mark = { key: nextKey.current++, action: item.action, display: feed.display };
            setMarks(current => [...current, mark]);
            schedule(() => setMarks(current => current.filter(entry => entry.key !== mark.key)), 1500);
          }, Number.isFinite(delay.current) ? Math.max(0, delay.current) : 0);
        }
      };
    };

    const close = () => {
      source?.close();
      source = undefined;
    };

    const visibility = () => {
      if (document.visibilityState === "visible") open();
      else close();
    };

    open();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      close();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [id, live]);

  // Chips never stack: only the newest non-finger mark renders.
  const latestChip = (() => {
    for (let i = marks.length - 1; i >= 0; i--) {
      if (!isFinger(marks[i])) return marks[i].key;
    }
    return -1;
  })();

  const ready = size.w > 0 && size.h > 0;

  return <div ref={layer} className={s.agentLayer} aria-hidden="true">
    {marks.map(mark => {
      const { action } = mark;
      const screen = mark.display;

      if (action.type === "tap" && screen) {
        if (!ready) return null;
        return <span key={mark.key} className={s.agentTap} style={{
          left: `${action.x / screen.width * size.w}px`,
          top: `${action.y / screen.height * size.h}px`,
        }} />;
      }

      if (action.type === "swipe" && screen) {
        if (!ready) return null;
        const x1 = action.from.x / screen.width * size.w;
        const y1 = action.from.y / screen.height * size.h;
        const x2 = action.to.x / screen.width * size.w;
        const y2 = action.to.y / screen.height * size.h;
        const dx = x2 - x1, dy = y2 - y1;
        const distance = Math.hypot(dx, dy);
        const style = {
          left: `${x1}px`,
          top: `${y1}px`,
          transform: `rotate(${Math.atan2(dy, dx)}rad)`,
          "--d": `${distance}px`,
        } as CSSProperties;
        return <span key={mark.key} className={s.agentSwipe} style={style}>
          <span className={s.agentTrail} />
          <span className={s.agentFinger} />
        </span>;
      }

      if (mark.key !== latestChip) return null;
      return <span key={mark.key} className={s.agentChip}>
        <i className={s.agentChipIcon} />
        <span className={s.agentChipLabel}>{chipText(action)}</span>
        {action.type === "text" && <span className={s.agentTyping}><i /><i /><i /></span>}
      </span>;
    })}
  </div>;
}
