"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { PhoneRow } from "./fixtures";
import { PhoneCard } from "./phone-card";
import { PhoneMutation, KeepPhone } from "./phone-mutations";
import type { Retention } from "../lib/retention";
import { Pill } from "./pill";
import { Button } from "./button";
import s from "./console.module.css";

type Item = { card: PhoneRow; state: string; lastUsed: string | null; retention: Retention | null };
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
  function toggle() {
    const value = view === "grid" ? "list" : "grid";
    setChoice(value);
    try { localStorage.setItem(key, value); } catch { /* Keep this session's choice. */ }
  }
  return <section aria-label="Phones">
    <div className={s.collectionTools}><Button tiny variant="ghost" onClick={toggle} aria-pressed={view === "list"}>{view === "grid" ? "Compact list" : "Card grid"}</Button></div>
    {view === "grid" ? <div className={s.grid}>{phones.map(phone => <PhoneCard key={phone.card.id} phone={phone.card} controlState={phone.state} retention={phone.retention} />)}</div>
      : <ul className={s.phoneList}>{phones.map(phone => <li key={phone.card.id} className={s.phoneRow}>
        <div><Link className={s.name} href={`/app/phones/${encodeURIComponent(phone.card.id)}`}>{phone.card.name}</Link><Pill kind={phone.card.state}>{phone.card.state}</Pill></div>
        <div className={s.rowDetails}><span>Last used: {phone.lastUsed ? `${phone.lastUsed.slice(0, 16).replace("T", " ")} UTC` : "Not recorded"}</span>{phone.retention && <>
          <span className={phone.retention.warning ? s.retentionWarning : undefined}>{phone.retention.message}</span>
          {phone.retention.canKeep && phone.state !== "keeping" && <KeepPhone id={phone.card.id} />}
        </>}</div>
        <div className={s.acts}><PhoneMutation id={phone.card.id} state={phone.state} /><Link className={s.cardLink} href={`/app/phones/${encodeURIComponent(phone.card.id)}`}>Open phone</Link></div>
      </li>)}</ul>}
  </section>;
}
