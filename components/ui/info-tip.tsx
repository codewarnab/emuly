"use client";
import { useEffect, useId, useRef, useState } from "react";
import s from "@/components/console.module.css";

/** A small "i" button. Hover, focus or click shows a short explanation. */
export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, [open]);
  return <span className={s.infoTip} ref={root} data-open={open || undefined}>
    <button type="button" aria-label={label} aria-describedby={id} aria-expanded={open}
      onClick={event => { event.preventDefault(); event.stopPropagation(); setOpen(value => !value); }}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3"/><path d="M8 7v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><circle cx="8" cy="4.8" r=".9" fill="currentColor"/></svg>
    </button>
    <span role="tooltip" id={id} className={s.infoTipBody}>{children}</span>
  </span>;
}
