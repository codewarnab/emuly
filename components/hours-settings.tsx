"use client";
import { useActionState, useState } from "react";
import { saveHours } from "../app/actions/settings";
import type { UserSettings } from "../lib/settings";
import type { Machine } from "../lib/github";
import { Button } from "./button";
import s from "./console.module.css";

export function HoursSettings({ settings, machines, message }: { settings: UserSettings; machines: Machine[]; message: string }) {
  const allowance = settings.allowance_core_hours;
  const [choice, setChoice] = useState("unchanged");
  const [result, action, pending] = useActionState(saveHours, { message: "" });
  return <form action={action} className={`${s.createForm} ${s.hoursForm}`}>
    <details className={s.allowance}><summary>Override monthly allowance</summary>
    <label>Monthly allowance<select name="allowance" value={choice} onChange={event => setChoice(event.target.value)}>
      <option value="unchanged">Keep current allowance</option><option value="auto">Use GitHub plan (automatic)</option>
      <option value="120">Free (120 core-hours)</option><option value="180">Pro (180 core-hours)</option><option value="custom">Custom</option>
    </select></label>
    {choice === "custom" && <label>Core-hours<input name="customAllowance" type="number" min="0" step="any" defaultValue={allowance} required /></label>}
    </details>
    <p>Your GitHub plan sets your allowance. <a href="https://github.com/settings/billing/usage" target="_blank" rel="noreferrer">Open GitHub billing</a>.</p>
    <label>Default machine<select name="machine" defaultValue={settings.default_machine ?? ""}>
      <option value="">Automatic (prefer 4 cores)</option>
      {settings.default_machine && !machines.some(machine => machine.name === settings.default_machine)
        && <option value={settings.default_machine}>{settings.default_machine} (saved choice)</option>}
      {machines.map(machine => <option key={machine.name} value={machine.name}>{machine.cpus}-core: {machine.cpus === 2 ? "lasts longer" : machine.cpus === 4 ? "faster boot" : machine.display_name}</option>)}
    </select></label>
    {message && <p role="status">{message}</p>}
    <label>Default idle timeout<select name="idle" defaultValue={String(settings.default_idle_min)}>
      <option value="30">30 minutes (recommended, saves hours)</option><option value="240">4 hours</option>
    </select></label>
    <p>Machine and idle defaults apply when you create a phone. Existing phones keep their settings.</p>
    <label className={s.checkboxLabel}><input type="checkbox" name="autoStop" defaultChecked={settings.auto_stop_before_empty} />
      <span>Stop my phones 30 minutes before my hours run out</span></label>
    <p>Uses estimated hours. If about 30 minutes or less remain, enabling this stops phones on the next tick (within about 60 seconds). Stopping keeps your phones.</p>
    <label className={s.checkboxLabel}><input type="checkbox" name="autoKeep" defaultChecked={settings.auto_keep} />
      <span>Keep my stopped phones automatically</span></label>
    <p>Starts and stops each phone when 1 day of retention remains. Uses about 3 minutes of your hours.</p>
    <Button disabled={pending}>{pending ? "Saving…" : "Save hours settings"}</Button>
    {result.message && <p role="status">{result.message}</p>}
  </form>;
}
