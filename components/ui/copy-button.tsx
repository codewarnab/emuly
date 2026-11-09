"use client";
import { useEffect, useRef, useState } from "react";
import s from "@/components/interaction.module.css";
import { Button } from "@/components/ui/button";
import { copyText, useToast } from "@/components/ui/ui-provider";

const DEVICE_COPY_TOAST = "Prompt copied. Your agent will give you a sign-in link";

async function freshPrompt() {
  const response = await fetch("/v1/agent/setup-code", { method: "POST", cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    if (typeof body.prompt !== "string") throw new Error("Could not make the sign-in prompt. Try again.");
    return { prompt: body.prompt as string, device: true };
  }
  if (!response.ok) throw new Error(body.message ?? "Could not make a setup code. Try again.");
  return { prompt: body.prompt as string, device: false };
}

export function CopyButton({ text, label = "Copy", description }: { text: string; label?: string; description?: string }) {
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [value, setValue] = useState(text);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = useToast();
  useEffect(() => () => clearTimeout(timer.current), []);
  return <><Button tiny aria-label={description ?? label} onClick={async () => {
    let copyValue = value;
    let device = false;
    if (label === "Copy prompt") {
      try {
        const fresh = await freshPrompt();
        copyValue = fresh.prompt;
        device = fresh.device;
        setValue(copyValue);
      }
      catch (error) { notify(error instanceof Error ? error.message : "Could not make a setup code."); return; }
    }
    if (await copyText(copyValue, notify, device ? DEVICE_COPY_TOAST : label === "Copy prompt" ? "Prompt copied" : "Copied")) {
      setFailed(false); setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 2500);
    } else setFailed(true);
  }}><span aria-live="polite">{copied ? "Copied ✓" : label}</span></Button>{failed && <label className={s.copyFallback}>Copy this text manually<textarea readOnly value={value} aria-label="Text to copy manually" onFocus={event => event.target.select()} /></label>}</>;
}
