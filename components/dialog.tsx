"use client";
import { useEffect, useRef } from "react";
import s from "./interaction.module.css";
export function Dialog({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>("input")?.focus();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={s.dialog} aria-label={title} onKeyDown={event => {
    if (event.key !== "Tab") return;
    const controls = Array.from(ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input, a[href], select, textarea, [tabindex="0"]'));
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === ref.current) close(); }}>
    <div className={s.dialogBody}><header><h2>{title}</h2><button onClick={close} aria-label={`Close ${title}`}>Esc</button></header>{children}</div>
  </dialog>;
}
