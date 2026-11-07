"use client";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import s from "./interaction.module.css";
type ToastItem = { id: number; message: string };
type GhostItem = { id: number; message: string; top: number; left: number; width: number };
type Remove = (id: number, ghost?: Omit<GhostItem, "id">) => void;
const ToastContext = createContext<(message: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);

// Sonner's toast timing: transform .4s, opacity .4s, height .4s, box-shadow .2s, all with `ease`.
const MOTION_MS = 400;
const EASE = "ease";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function UIProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [ghosts, setGhosts] = useState<GhostItem[]>([]);
  const stack = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<number, number>());
  const sequence = useRef(0);
  const notify = useCallback((message: string) => {
    setToasts(items => [...items.slice(-2), { id: ++sequence.current, message }]);
  }, []);
  const remove = useCallback<Remove>((id, ghost) => {
    setToasts(items => items.filter(item => item.id !== id));
    if (ghost) setGhosts(items => [...items.filter(item => item.id !== id), { id, ...ghost }]);
  }, []);
  const clearGhost = useCallback((id: number) => setGhosts(items => items.filter(item => item.id !== id)), []);

  useEffect(() => {
    const reset = () => positions.current.clear();
    window.addEventListener("resize", reset);
    return () => window.removeEventListener("resize", reset);
  }, []);

  // The toasts that stay move as one piece, in the same 400ms `ease` pass as the toast that left.
  useLayoutEffect(() => {
    const node = stack.current;
    if (!node) return;
    const slots = Array.from(node.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element.hasAttribute("data-toast-id")
    );
    const before = new Map<HTMLElement, number>();
    for (const slot of slots) before.set(slot, slot.getBoundingClientRect().top);
    for (const slot of slots) for (const animation of slot.getAnimations()) animation.cancel();
    const animate = !reducedMotion();
    const next = new Map<number, number>();
    for (const slot of slots) {
      const id = Number(slot.dataset.toastId);
      const top = slot.getBoundingClientRect().top;
      next.set(id, top);
      const previous = positions.current.get(id);
      if (!animate || previous === undefined) continue;
      const offset = (before.get(slot) ?? top) - top;
      if (Math.abs(offset) < 1) continue;
      slot.animate(
        [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }],
        { duration: MOTION_MS, easing: EASE }
      );
    }
    positions.current = next;
  }, [toasts]);

  return <ToastContext value={notify}>{children}<div className={s.toasts} ref={stack} aria-live="polite" aria-relevant="additions">
    {ghosts.map(ghost => <ToastGhost key={ghost.id} {...ghost} clear={clearGhost} />)}
    {toasts.map(item => <div className={s.toastSlot} key={item.id} data-toast-id={item.id}>
      <Toast {...item} remove={remove} />
    </div>)}
  </div></ToastContext>;
}

function Toast({ id, message, remove }: ToastItem & { remove: Remove }) {
  const node = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const remaining = useRef(4000);
  const dismiss = useCallback(() => {
    const element = node.current;
    if (!element || reducedMotion()) { remove(id); return; }
    const rect = element.getBoundingClientRect();
    remove(id, { message, top: rect.top, left: rect.left, width: rect.width });
  }, [id, message, remove]);
  useLayoutEffect(() => {
    const element = node.current;
    if (!element || reducedMotion()) return;
    const animation = element.animate([
      { opacity: 0, transform: "translateY(100%)" },
      { opacity: 1, transform: "translateY(0)" }
    ], { duration: MOTION_MS, easing: EASE });
    return () => animation.cancel();
  }, []);
  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = setTimeout(dismiss, remaining.current);
    return () => { clearTimeout(timer); remaining.current -= Date.now() - started; };
  }, [paused, dismiss]);
  return <div className={s.toast} ref={node} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
    <span>{message}</span><button aria-label="Dismiss notification" onClick={dismiss}>×</button>
  </div>;
}

// The toast that leaves is copied at its last position, so it can slide out while the stack closes at the same time.
function ToastGhost({ id, message, top, left, width, clear }: GhostItem & { clear: (id: number) => void }) {
  const node = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = node.current;
    if (!element) { clear(id); return; }
    const animation = element.animate([
      { opacity: 1, transform: "translateY(0)" },
      { opacity: 0, transform: "translateY(100%)" }
    ], { duration: MOTION_MS, easing: EASE });
    animation.finished.then(() => clear(id), () => {});
    return () => animation.cancel();
  }, [id, clear]);
  return <div className={s.toast} ref={node} aria-hidden="true" style={{ position: "fixed", top, left, width, boxSizing: "border-box", pointerEvents: "none" }}>
    <span>{message}</span><button tabIndex={-1}>×</button>
  </div>;
}

export async function copyText(text: string, notify: (message: string) => void, label = "Copied") {
  try { await navigator.clipboard.writeText(text); notify(`${label}.`); return true; }
  catch { notify("Copy unavailable. Select the text and copy it manually."); return false; }
}
