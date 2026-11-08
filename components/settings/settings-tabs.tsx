"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SETTINGS_TABS } from "@/lib/shared/keyboard";
import s from "@/components/console.module.css";

export function SettingsTabs() {
  const path = usePathname();
  return <nav className={s.settingsTabs} aria-label="Settings">
    {SETTINGS_TABS.map(tab => <Link key={tab.href} href={tab.href} aria-current={path.startsWith(tab.href) ? "page" : undefined}>
      {tab.label}
    </Link>)}
  </nav>;
}
