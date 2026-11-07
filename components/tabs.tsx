"use client";
import { useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PHONE_TABS, phoneTabHref } from "../lib/keyboard";
import s from "./console.module.css";
export const TABS = PHONE_TABS;
export type Tab = (typeof TABS)[number];
const labels: Record<Tab, string> = { log: "Agent log", apps: "Apps", backups: "Backups", danger: "Danger" };
export function Tabs({ active, phoneId }: { active: Tab; phoneId: string }) {
  const router = useRouter();
  const refs = useRef<(HTMLAnchorElement | null)[]>([]);
  return <nav role="tablist" className={s.tabs} aria-label="Phone" onKeyDown={event => {
    const index = TABS.indexOf(active);
    const next = event.key === "ArrowRight" ? (index + 1) % 4 : event.key === "ArrowLeft" ? (index + 3) % 4 : event.key === "Home" ? 0 : event.key === "End" ? 3 : -1;
    if (next < 0) return;
    event.preventDefault(); refs.current[next]?.focus();
    router.push(phoneTabHref(phoneId, TABS[next]!), { scroll: false });
  }}>
    {TABS.map((value, index) => <Link ref={node => { refs.current[index] = node; }} key={value} role="tab" id={`tab-${value}`} aria-controls={`panel-${value}`} aria-selected={value === active} tabIndex={value === active ? 0 : -1} href={phoneTabHref(phoneId, value)} scroll={false} className={`${value === active ? s.on : ""} ${value === "danger" ? s.dangerTab : ""}`}>{labels[value]}</Link>)}
  </nav>;
}
