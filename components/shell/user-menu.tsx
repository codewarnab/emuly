"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import s from "@/components/console.module.css";

type Phase = "closed" | "open" | "closing";

const icons = {
  hours: <path d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />,
  webhooks: <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />,
  billing: <path d="M3 7h18v10H3zM3 11h18M7 15h3" />,
  logout: <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" />,
};

function Icon({ name }: { name: keyof typeof icons }) {
  return <svg className={s.menuIcon} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{icons[name]}</svg>;
}

export function UserMenu({ initials, login }: { initials: string; login: string }) {
  const [phase, setPhase] = useState<Phase>("closed");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const open = phase === "open";

  const close = (focusTrigger = false) => {
    setPhase(p => (p === "open" ? "closing" : p));
    if (focusTrigger) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onPointer = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(true); } };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(panel.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1
      : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null;
    if (next === null || !items.length) return;
    e.preventDefault();
    items[(next + items.length) % items.length]!.focus();
  };

  return <div className={s.userMenu} ref={root}>
    <button ref={trigger} type="button" className={s.avatarButton} aria-label={`Account: ${login}`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={id}
      onClick={() => setPhase(p => (p === "open" ? "closing" : "open"))}>
      <span className={s.avatar}>{initials}</span>
    </button>
    {phase !== "closed" && <div ref={panel} id={id} role="menu" aria-label="Account" data-state={phase}
      className={s.menuContent} onKeyDown={onMenuKey}
      onAnimationEnd={() => setPhase(p => (p === "closing" ? "closed" : p))}>
      <div className={s.menuHeader}>
        <span className={`${s.avatar} ${s.avatarLarge}`} aria-hidden="true">{initials}</span>
        <span className={s.menuWho}><small>Signed in as</small><b>{login}</b></span>
      </div>
      <div className={s.menuGroup}>
        <Link role="menuitem" className={s.menuItem} href="/app/settings/hours" onClick={() => close()}>
          <Icon name="hours" />Hours<kbd>Settings</kbd></Link>
        <Link role="menuitem" className={s.menuItem} href="/app/settings/webhooks" onClick={() => close()}>
          <Icon name="webhooks" />Webhooks<kbd>Settings</kbd></Link>
        <Link role="menuitem" className={s.menuItem} href="/app#usage" onClick={() => close()}>
          <Icon name="billing" />Usage</Link>
      </div>
      <form action="/auth/logout" method="post" className={s.menuGroup}>
        <button role="menuitem" type="submit" className={`${s.menuItem} ${s.menuDanger}`}>
          <Icon name="logout" />Log out</button>
      </form>
    </div>}
  </div>;
}
