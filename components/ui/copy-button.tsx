"use client";
import { useEffect, useRef, useState } from "react";
import s from "@/components/interaction.module.css";
import { Button } from "@/components/ui/button";
import { copyText, useToast } from "@/components/ui/ui-provider";

async function freshPrompt() {
  const response = await fetch("/v1/agent/setup-code", { method: "POST", cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? "Could not make a setup code. Try again.");
  return body.prompt as string;
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
    if (label === "Copy prompt") {
      try { copyValue = await freshPrompt(); setValue(copyValue); }
      catch (error) { notify(error instanceof Error ? error.message : "Could not make a setup code."); return; }
    }
    if (await copyText(copyValue, notify, label === "Copy prompt" ? "Prompt copied" : "Copied")) {
      setFailed(false); setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 2500);
    } else setFailed(true);
  }}><span aria-live="polite">{copied ? "Copied ✓" : label}</span></Button>{failed && <label className={s.copyFallback}>Copy this text manually<textarea readOnly value={value} aria-label="Text to copy manually" onFocus={event => event.target.select()} /></label>}</>;
}
