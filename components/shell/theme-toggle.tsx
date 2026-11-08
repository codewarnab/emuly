"use client";

import { useSyncExternalStore } from "react";
import s from "@/components/console.module.css";

export type Theme = "light" | "dark" | "system";
const key = "phonelink-theme";
let transientTheme: Theme = "system";
function preference(): Theme {
  try { const value = localStorage.getItem(key); return value === "light" || value === "dark" || value === "system" ? value : transientTheme; }
  catch { return transientTheme; }
}
function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener("phonelink-theme", callback);
  return () => { window.removeEventListener("storage", callback); window.removeEventListener("phonelink-theme", callback); };
}
function resolved(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

// One icon button: sun in light, moon in dark. Click flips it, with a circular
// reveal from the button when the browser supports view transitions.
export function ThemeToggle() {
  useSyncExternalStore(subscribe, preference, () => "system" as Theme);
  return <button type="button" className={s.theme} aria-label="Toggle dark mode"
    title="Toggle dark mode (t)" onClick={event => toggleTheme(event.currentTarget)}>
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" className={s.themeIcon}>
      <mask id="theme-moon"><rect width="24" height="24" fill="white" /><circle className={s.themeBite} cx="24" cy="4" r="9" fill="black" /></mask>
      <circle className={s.themeCore} cx="12" cy="12" r="5" fill="currentColor" mask="url(#theme-moon)" />
      <g className={s.themeRays} stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M12 1.5v2M12 20.5v2M1.5 12h2M20.5 12h2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M4.6 19.4L6 18M18 6l1.4-1.4" />
      </g>
    </svg>
  </button>;
}

export function toggleTheme(origin?: HTMLElement): Theme {
  const next: Theme = resolved() === "dark" ? "light" : "dark";
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  if (!doc.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) { setTheme(next); return next; }
  const box = origin?.getBoundingClientRect();
  const x = box ? box.left + box.width / 2 : innerWidth - 40, y = box ? box.top + box.height / 2 : 40;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  doc.startViewTransition(() => setTheme(next)).ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 450, easing: "cubic-bezier(.2,.7,.2,1)", pseudoElement: "::view-transition-new(root)" });
  }).catch(() => {});
  return next;
}

export function setTheme(choice: Theme) {
  transientTheme = choice;
  try { localStorage.setItem(key, choice); } catch { /* Choice still applies for this page. */ }
  document.documentElement.dataset.theme = choice === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : choice;
  window.dispatchEvent(new Event("phonelink-theme"));
}
export function cycleTheme(): Theme {
  return toggleTheme(document.querySelector<HTMLElement>("[aria-label='Toggle dark mode']") ?? undefined);
}
