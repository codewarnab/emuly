"use client";
import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { DIRECT_BLOCKED_HINT, DIRECT_BLOCKED_UI as ui } from "@/lib/phone/network-hint";
import s from "@/components/phone/network-notice.module.css";

/** A small tag on the side of the page. A click opens short fix steps and a prompt for the user's agent. */
export function NetworkNotice() {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return <>
    <div className={s.peek} role="status">
      <button type="button" className={s.open} onClick={() => setOpen(true)}><span aria-hidden="true">⚠</span> {ui.peek}</button>
      <button type="button" className={s.hide} aria-label="Hide network notice" onClick={() => setHidden(true)}>×</button>
    </div>
    {open && <Dialog title={ui.title} close={() => setOpen(false)}>
      <p className={s.summary}>{ui.summary}</p>
      <ol className={s.steps}>{ui.fix.map(step => <li key={step}>{step}</li>)}</ol>
      <div className={s.copy}><CopyButton text={ui.agentPrompt} label="Copy prompt for your agent" /></div>
      <details className={s.sources}><summary>Sources</summary>
        <ul>{DIRECT_BLOCKED_HINT.sources.map(source => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>)}</ul>
      </details>
    </Dialog>}
  </>;
}
