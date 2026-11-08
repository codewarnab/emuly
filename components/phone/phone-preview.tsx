"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import s from "@/components/console.module.css";

export function PhonePreview({ id, ready, children }: { id?: string; ready?: boolean; children: ReactNode }) {
  const [frame, setFrame] = useState("");
  const element = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFrame("");
    if (!id || !ready) return;
    let disposed = false;
    let visible = false;
    let busy = false;
    let current = "";
    let controller: AbortController | undefined;

    async function refresh() {
      if (disposed || busy || !visible || document.hidden) return;
      busy = true;
      const request = new AbortController();
      controller = request;
      let next = "";
      try {
        const response = await fetch(`/app/phones/${encodeURIComponent(id!)}/screen.png`, {
          cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) return;
        next = URL.createObjectURL(await response.blob());
        const image = new Image();
        image.src = next;
        await image.decode();
        if (disposed || request.signal.aborted || !visible || document.hidden) return;
        const previous = current;
        current = next;
        next = "";
        setFrame(current);
        URL.revokeObjectURL(previous);
      } catch {
        // Keep the last preview during a temporary connection failure.
      } finally {
        if (next) URL.revokeObjectURL(next);
        busy = false;
      }
    }

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) void refresh();
      else controller?.abort();
    });
    if (element.current) observer.observe(element.current);
    const visibility = () => { if (document.hidden) controller?.abort(); else void refresh(); };
    document.addEventListener("visibilitychange", visibility);
    const changed = () => { void refresh(); };
    window.addEventListener("phonelink:changed", changed);
    return () => {
      disposed = true;
      controller?.abort();
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("phonelink:changed", changed);
      URL.revokeObjectURL(current);
    };
  }, [id, ready]);

  return <div ref={element} className={`${s.thumb} ${frame && ready ? s.thumbReal : ""}`}>
    {frame && ready ? <img src={frame} alt="Phone screen preview" className={s.thumbPreview}
      title="Phone screen preview" /> : children}
  </div>;
}
