"use client";
import { useEffect } from "react";
import { shortcutKey } from "../lib/keyboard";
export function useShortcuts(handle: (key: string) => void, open: boolean) {
  useEffect(() => {
    let prefixAt = 0;
    function listener(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      const target = event.target as HTMLElement;
      const editing = !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
      const key = shortcutKey(event, editing);
      if (key === "command") { event.preventDefault(); handle(key); return; }
      if (open || document.querySelector("dialog[open]") || !key) { prefixAt = 0; return; }
      if (key === "escape") {
        document.querySelectorAll("details[open]").forEach(item => item.removeAttribute("open"));
      }
      if (key === "g") { prefixAt = Date.now(); return; }
      const sequence = prefixAt && Date.now() - prefixAt < 1200;
      prefixAt = 0;
      if (sequence && ["p", "1", "2"].includes(key)) { event.preventDefault(); handle(`g ${key}`); }
      else if (["?", "1", "2", "3", "4", "w", "s", "c", "t"].includes(key)) { event.preventDefault(); handle(key); }
    }
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [handle, open]);
}
