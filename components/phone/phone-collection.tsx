"use client";
import { startTransition, useEffect, useState, ViewTransition } from "react";
import Link from "next/link";
import type { PhoneRow } from "@/lib/shared/fixtures";
import { PhoneCard } from "@/components/phone/phone-card";
import { PhoneMutation, KeepPhone } from "@/components/phone/phone-mutations";
import type { Retention } from "@/lib/data/retention";
import { Pill } from "@/components/ui/pill";
import s from "@/components/console.module.css";

type Item = { card: PhoneRow; state: string; codespace: string | null; lastUsed: string | null; retention: Retention | null };
export function PhoneCollection({ phones, userId }: { phones: Item[]; userId: number }) {
  const [choice, setChoice] = useState<"grid" | "list" | null>(null);
  const key = `phonelink-phone-view-${userId}`;
  useEffect(() => {
    try {
      const value = localStorage.getItem(key);
      setChoice(value === "grid" || value === "list" ? value : null);
    } catch { /* The automatic view still works when storage is unavailable. */ }
  }, [key]);
  const view = choice ?? (phones.length > 6 ? "list" : "grid");
  function choose(value: "grid" | "list") {
    // A transition lets <ViewTransition> morph each phone between the grid and the list.
    startTransition(() => setChoice(value));
    try { localStorage.setItem(key, value); } catch { /* Keep this session's choice. */ }
  }
  return <section aria-label="Phones">
    <div className={s.collectionTools} role="group" aria-label="Phone view">
      <button type="button" className={s.viewToggle} aria-pressed={view === "grid"} aria-label="Card grid" title="Card grid" onClick={() => choose("grid")}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2"/><rect x="9" y="9" width="5.5" height="5.5" rx="1.2"/></svg>
      </button>
      <button type="button" className={s.viewToggle} aria-pressed={view === "list"} aria-label="Compact list" title="Compact list" onClick={() => choose("list")}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><rect x="1.5" y="2.5" width="13" height="2.2" rx="1"/><rect x="1.5" y="6.9" width="13" height="2.2" rx="1"/><rect x="1.5" y="11.3" width="13" height="2.2" rx="1"/></svg>
      </button>
    </div>
    {view === "grid" ? <div className={s.grid}>{phones.map(phone => <ViewTransition key={phone.card.id} name={`phone-${phone.card.id}`} share="phone-morph" default="none"><div><PhoneCard phone={phone.card} controlState={phone.state} retention={phone.retention} codespace={phone.codespace} /></div></ViewTransition>)}</div>
      : <ul className={s.phoneList}>{phones.map(phone => <ViewTransition key={phone.card.id} name={`phone-${phone.card.id}`} share="phone-morph" default="none"><li className={s.phoneRow}>
        <div><Link className={s.name} href={`/app/phones/${encodeURIComponent(phone.card.id)}`}>{phone.card.name}</Link><Pill kind={phone.card.state}>{phone.card.statusLabel ?? phone.card.state}</Pill></div>
        <div className={s.rowDetails}><span>Last used: {phone.lastUsed ? `${phone.lastUsed.slice(0, 16).replace("T", " ")} UTC` : "Not recorded"}</span>{phone.retention && <>
          <span className={phone.retention.warning ? s.retentionWarning : undefined}>{phone.retention.message}</span>
          {phone.retention.canKeep && phone.state !== "keeping" && <KeepPhone id={phone.card.id} />}
        </>}</div>
        <div className={s.acts}><PhoneMutation id={phone.card.id} state={phone.state} /><Link className={s.cardLink} href={`/app/phones/${encodeURIComponent(phone.card.id)}`}>Open phone</Link></div>
      </li></ViewTransition>)}</ul>}
  </section>;
}
