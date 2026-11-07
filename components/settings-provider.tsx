"use client";
import { createContext, useContext, useEffect, useOptimistic, useState, useTransition } from "react";
import { saveHoursField } from "../app/actions/settings";
import type { HoursField } from "../lib/settings";
import s from "./console.module.css";

export type HoursValues = { idle: number; autoStop: boolean; autoKeep: boolean; plan: "free" | "pro" | "custom"; allowance: number };
const SettingsContext = createContext<{
  values: HoursValues; pending: boolean; save: (field: HoursField, value: number | boolean | "free" | "pro") => void;
} | null>(null);

export function SettingsProvider({ initial, children }: { initial: HoursValues; children: React.ReactNode }) {
  const [confirmed, setConfirmed] = useState(initial);
  const [values, optimistic] = useOptimistic(confirmed, (state, patch: Partial<HoursValues>) => ({ ...state, ...patch }));
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (status !== "Saved") return;
    const timer = setTimeout(() => setStatus(""), 1500);
    return () => clearTimeout(timer);
  }, [status]);
  function save(field: HoursField, value: number | boolean | "free" | "pro") {
    const patch = field === "plan" ? typeof value === "number"
      ? { plan: "custom" as const, allowance: value }
      : { plan: value as "free" | "pro", allowance: value === "pro" ? 180 : 120 }
      : { [field]: value };
    if (Object.entries(patch).every(([key, next]) => confirmed[key as keyof HoursValues] === next)) return;
    setStatus("Saving…");
    startTransition(async () => {
      optimistic(patch);
      try {
        const result = await saveHoursField(field, value);
        if (result.ok) setConfirmed(state => ({ ...state, ...patch }));
        setStatus(result.message);
      } catch { setStatus("Settings could not be saved. Try again."); }
    });
  }
  return <SettingsContext value={{ values, pending, save }}>
    <p className={s.saveStatus} data-saved={status === "Saved"} aria-live="polite" aria-atomic="true">{status}</p>
    {children}
  </SettingsContext>;
}
export function useSettingsControls() { return useContext(SettingsContext); }
