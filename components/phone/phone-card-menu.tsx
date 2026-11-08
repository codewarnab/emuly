"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePhoneAction } from "@/components/phone/use-phone-action";
import { copyText, useToast } from "@/components/ui/ui-provider";
import s from "@/components/console.module.css";

/** The card's `…` menu: less common actions, and delete with an inline confirm. */
export function PhoneCardMenu({ id, codespace }: { id: string; codespace: string | null }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [, action, pending] = usePhoneAction();
  const notify = useToast();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) {
        setOpen(false); setConfirming(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, [open]);
  return <div className={s.cardMenu} ref={root}>
    <button type="button" className={s.cardMenuButton} aria-label={`More actions for ${id}`} aria-expanded={open}
      onClick={() => { setOpen(value => !value); setConfirming(false); }}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg>
    </button>
    {open && <div className={s.cardMenuList} role="menu">
      {!confirming ? <>
        <Link role="menuitem" href={`/app/phones/${encodeURIComponent(id)}?tab=backups`}>Backups</Link>
        {codespace && <button role="menuitem" type="button" onClick={() => { void copyText(codespace, notify, "Codespace name copied"); setOpen(false); }}>Copy codespace name</button>}
        <button role="menuitem" type="button" className={s.cardMenuDanger} onClick={() => setConfirming(true)}>Delete…</button>
      </> : <form action={action} className={s.cardMenuConfirm}>
        <input type="hidden" name="operation" value="delete" />
        <input type="hidden" name="phoneId" value={id} />
        <input type="hidden" name="confirmation" value={id} />
        <p>Delete this phone for good?</p>
        <div>
          <button type="button" autoFocus onClick={() => setConfirming(false)}>Cancel</button>
          <button className={s.cardMenuDanger} disabled={pending}>{pending ? "Deleting…" : "Delete"}</button>
        </div>
      </form>}
    </div>}
  </div>;
}
