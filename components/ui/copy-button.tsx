"use client";
import { useEffect, useRef, useState } from "react";
import s from "@/components/interaction.module.css";
import { Button } from "@/components/ui/button";
import { copyText, useToast } from "@/components/ui/ui-provider";

const DEVICE_COPY_TOAST = "Prompt copied. Your agent will give you a sign-in link";

export async function freshPrompt() {
  const response = await fetch("/v1/agent/setup-code", { method: "POST", cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    if (typeof body.prompt !== "string") throw new Error("Could not make the sign-in prompt. Try again.");
    return { prompt: body.prompt as string, device: true };
  }
  if (!response.ok) throw new Error(body.message ?? "Could not make a setup code. Try again.");
  return { prompt: body.prompt as string, device: false };
}

/** Starts the clipboard write inside the click, with the text as a promise. The browser then
    keeps the copy even if the user switches tabs while the prompt loads. */
export async function copyPending(text: Promise<string>) {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
  const blob = text.then(value => new Blob([value], { type: "text/plain" }));
  await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
  return true;
}

export function CopyButton({ text, label = "Copy", description }: { text: string; label?: string; description?: string }) {
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [value, setValue] = useState(text);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = useToast();
  useEffect(() => () => clearTimeout(timer.current), []);
  const done = () => { setFailed(false); setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 2500); };
  return <><Button tiny aria-label={description ?? label} aria-busy={pending || undefined} disabled={pending} onClick={async () => {
    if (label !== "Copy prompt") {
      if (await copyText(value, notify, "Copied")) done(); else setFailed(true);
      return;
    }
    setPending(true);
    const fresh = freshPrompt();
    fresh.catch(() => {});
    try {
      let early = false;
      try { early = await copyPending(fresh.then(f => f.prompt)); } catch { early = false; }
      const { prompt, device } = await fresh;
      setValue(prompt);
      if (early) { notify(`${device ? DEVICE_COPY_TOAST : "Prompt copied"}.`); done(); }
      else if (await copyText(prompt, notify, device ? DEVICE_COPY_TOAST : "Prompt copied")) done();
      else setFailed(true);
    }
    catch (error) { notify(error instanceof Error ? error.message : "Could not make a setup code."); }
    finally { setPending(false); }
  }}><span aria-live="polite">{pending ? "Preparing…" : copied ? "Copied ✓" : label}</span></Button>{failed && <label className={s.copyFallback}>Copy this text manually<textarea readOnly value={value} aria-label="Text to copy manually" onFocus={event => event.target.select()} /></label>}</>;
}
