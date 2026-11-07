"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import s from "./interaction.module.css";
const ToastContext = createContext<(message: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);
export function UIProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; message: string }[]>([]);
  const sequence = useRef(0);
  const notify = useCallback((message: string) => {
    setToasts(items => [...items.slice(-2), { id: ++sequence.current, message }]);
  }, []);
  const dismiss = useCallback((id: number) => setToasts(items => items.filter(item => item.id !== id)), []);
  return <ToastContext value={notify}>{children}<div className={s.toasts} aria-live="polite" aria-relevant="additions">
    {toasts.map(item => <Toast key={item.id} {...item} dismiss={dismiss} />)}
  </div></ToastContext>;
}
function Toast({ id, message, dismiss }: { id: number; message: string; dismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(4000);
  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = setTimeout(() => dismiss(id), remaining.current);
    return () => { clearTimeout(timer); remaining.current -= Date.now() - started; };
  }, [paused, dismiss, id]);
  return <div className={s.toast} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
    <span>{message}</span><button aria-label="Dismiss notification" onClick={() => dismiss(id)}>×</button>
  </div>;
}
export async function copyText(text: string, notify: (message: string) => void, label = "Copied") {
  try { await navigator.clipboard.writeText(text); notify(`${label}.`); return true; }
  catch { notify("Copy unavailable. Select the text and copy it manually."); return false; }
}
