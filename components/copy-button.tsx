"use client";
import { useEffect, useRef, useState } from "react";
import s from "./interaction.module.css";
import { Button } from "./button";
import { copyText, useToast } from "./ui-provider";
export function CopyButton({ text, label = "Copy", description }: { text: string; label?: string; description?: string }) {
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = useToast();
  useEffect(() => () => clearTimeout(timer.current), []);
  return <><Button tiny aria-label={description ?? label} onClick={async () => {
    if (await copyText(text, notify, label === "Copy prompt" ? "Prompt copied" : "Copied")) {
      setFailed(false); setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 2500);
    } else setFailed(true);
  }}><span aria-live="polite">{copied ? "Copied ✓" : label}</span></Button>{failed && <label className={s.copyFallback}>Copy this text manually<textarea readOnly value={text} aria-label="Text to copy manually" onFocus={event => event.target.select()} /></label>}</>;
}
