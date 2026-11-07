"use client";
import { useEffect } from "react";
import { shortcutKey } from "../lib/keyboard";
export function useShortcuts(handle: (key: string) => void, open: boolean, clock: () => number = Date.now) {
  useEffect(() => {
    let prefixAt: number | null = null;
    function listener(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      const target = event.target as HTMLElement;
      const editing = !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
      const key = shortcutKey(event, editing);
      if (key === "command") { event.preventDefault(); handle(key); return; }
      if (open || document.querySelector("dialog[open]") || !key) { prefixAt = null; return; }
      if (key === "escape") {
        document.querySelectorAll("details[open]").forEach(item => item.removeAttribute("open"));
      }
      if (key === "g") { prefixAt = clock(); return; }
      const sequence = prefixAt !== null && clock() - prefixAt < 1200;
      prefixAt = null;
      if (sequence && /^(p|s|w|[1-9])$/.test(key)) { event.preventDefault(); handle(`g ${key}`); }
      else if (["?", "1", "2", "3", "4", "w", "s", "c", "t", "n"].includes(key)) { event.preventDefault(); handle(key); }
    }
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [handle, open, clock]);
}
