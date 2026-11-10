"use client";
import { useEffect, useRef, useState } from "react";
import s from "@/components/phone/phone-screen.module.css";
import type { AgentAction } from "@/lib/phone/agent-action";

type Display = { width: number; height: number };
type Feed = { display: Display | null; actions: { id: number; at: string; action: AgentAction }[] };
type Mark = { key: number; action: AgentAction; display: Display | null };

function chipText(action: AgentAction): string {
  switch (action.type) {
    case "text": return "Typing…";
    case "key":
      return action.key === "back" ? "Back" : action.key === "home" ? "Home" : action.key === "recent" ? "Recent" : "Key press";
    case "command": return action.label;
    case "tap": return "Tap";
    case "swipe": return "Swipe";
  }
}

export function AgentOverlay({ id, live, delayMs, onActivity }: {
  id: string; live: boolean; delayMs: number; onActivity?: (at: number) => void;
}) {
  const [marks, setMarks] = useState<Mark[]>([]);
  const display = useRef<Display | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const nextKey = useRef(0);
  const activity = useRef(onActivity);
  activity.current = onActivity;
  const delay = useRef(delayMs);
  delay.current = delayMs;

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
        display.current = feed.display;
        for (const item of feed.actions) {
          schedule(() => {
            activity.current?.(Date.now());
            const mark: Mark = { key: nextKey.current++, action: item.action, display: display.current };
            setMarks(current => [...current, mark]);
            schedule(() => setMarks(current => current.filter(entry => entry.key !== mark.key)), 1500);
          }, Math.max(0, delay.current));
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

  return <div className={s.agentLayer}>
    {marks.map(mark => {
      const { action } = mark;
      const screen = mark.display;
      if (action.type === "tap" && screen) {
        return <span key={mark.key} className={s.agentTap} style={{
          left: `${action.x / screen.width * 100}%`,
          top: `${action.y / screen.height * 100}%`,
        }} />;
      }
      if (action.type === "swipe" && screen) {
        const x1 = action.from.x / screen.width * 100, y1 = action.from.y / screen.height * 100;
        const x2 = action.to.x / screen.width * 100, y2 = action.to.y / screen.height * 100;
        return <svg key={mark.key} className={s.agentSwipe} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(70,120,255,.9)" strokeWidth={7}
            strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#fff" strokeWidth={3}
            strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <circle cx={x2} cy={y2} r={2.4} fill="#fff" stroke="rgba(70,120,255,.9)" strokeWidth={1.5}
            vectorEffect="non-scaling-stroke" />
        </svg>;
      }
      return <span key={mark.key} className={s.agentChip}>{chipText(action)}</span>;
    })}
  </div>;
}
