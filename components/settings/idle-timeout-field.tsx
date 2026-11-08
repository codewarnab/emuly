"use client";
import { useState } from "react";
import { IDLE_MAX, IDLE_MIN, IDLE_PRESETS, idleLabel } from "@/lib/idle";
import s from "@/components/console.module.css";

/** Preset idle timeouts plus a custom number of minutes. Submits one field: `name`. */
export function IdleTimeoutField({ name, defaultValue, label = "Stop after idle" }: {
  name: string; defaultValue: number; label?: string;
}) {
  const preset = (IDLE_PRESETS as readonly number[]).includes(defaultValue);
  const [choice, setChoice] = useState(preset ? String(defaultValue) : "custom");
  const [custom, setCustom] = useState(String(defaultValue));
  return <fieldset className={s.idleField}>
    <legend>{label}</legend>
    <div className={s.idleChoices} role="radiogroup">
      {IDLE_PRESETS.map(minutes => <label key={minutes} className={s.idleChip}>
        <input type="radio" name={`${name}-choice`} value={minutes} checked={choice === String(minutes)}
          onChange={() => setChoice(String(minutes))} />
        <span>{idleLabel(minutes)}</span>
      </label>)}
      <label className={s.idleChip}>
        <input type="radio" name={`${name}-choice`} value="custom" checked={choice === "custom"} onChange={() => setChoice("custom")} />
        <span>Custom</span>
      </label>
    </div>
    {choice === "custom"
      ? <label className={s.idleCustom}>
        <input type="number" name={name} min={IDLE_MIN} max={IDLE_MAX} step={1} required value={custom}
          onChange={event => setCustom(event.target.value)} aria-label="Idle minutes" />
        <span>minutes ({IDLE_MIN}–{IDLE_MAX})</span>
      </label>
      : <input type="hidden" name={name} value={choice} />}
  </fieldset>;
}
