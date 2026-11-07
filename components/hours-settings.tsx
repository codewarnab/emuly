"use client";
import { useEffect, useRef, useState } from "react";
import { IDLE_MAX, IDLE_MIN, IDLE_PRESETS, idleLabel, validIdle } from "../lib/idle";
import { useSettingsControls } from "./settings-provider";
import { InfoTip } from "./info-tip";
import s from "./console.module.css";

export function HoursSettings() {
  const controls = useSettingsControls();
  const [customIdle, setCustomIdle] = useState(false);
  if (!controls) return null;
  const { values, pending, save } = controls;
  const idleCustom = customIdle || !(IDLE_PRESETS as readonly number[]).includes(values.idle);
  const planCustom = values.plan === "custom";
  return <div className={`${s.createForm} ${s.hoursForm}`}>
    <fieldset className={s.idleField} disabled={pending}>
      <legend>Idle stop for new phones</legend>
      <div className={s.idleChoices} role="radiogroup" aria-label="Idle stop for new phones">
        {IDLE_PRESETS.map(minutes => <label key={minutes} className={s.idleChip}>
          <input type="radio" name="idle" checked={!idleCustom && values.idle === minutes}
            onChange={() => { setCustomIdle(false); save("idle", minutes); }} /><span>{idleLabel(minutes)}</span>
        </label>)}
        <label className={s.idleChip}><input type="radio" name="idle" checked={idleCustom} onChange={() => setCustomIdle(true)} /><span>Custom</span></label>
      </div>
      {idleCustom && <NumberSetting label="Idle minutes" value={values.idle} min={IDLE_MIN} max={IDLE_MAX}
        valid={validIdle} save={value => save("idle", value)} disabled={pending} suffix="minutes" />}
    </fieldset>
    <label className={s.settingToggle}>
      <span><b>Stop phones before hours run out <InfoTip label="What auto-stop does">
        When your estimated hours drop to about 30 minutes, phonelink stops your running phones.
        Stopping keeps each phone and its apps. GitHub stops charging, so you do not pay past your free hours.
        Wake a phone again when your hours reset or after you add more.
      </InfoTip></b><small>At about 30 min left.</small></span>
      <input type="checkbox" role="switch" className={s.switch} checked={values.autoStop} disabled={pending}
        onChange={event => save("autoStop", event.target.checked)} />
    </label>
    <label className={s.settingToggle}>
      <span><b>Keep stopped phones</b><small>Stops GitHub from deleting them. About 3 min each.</small></span>
      <input type="checkbox" role="switch" className={s.switch} checked={values.autoKeep} disabled={pending}
        onChange={event => save("autoKeep", event.target.checked)} />
    </label>
    <fieldset className={s.idleField} disabled={pending}>
      <legend>Your GitHub plan</legend>
      <div className={s.idleChoices} role="radiogroup" aria-label="Your GitHub plan">
        {([["free", "Free · 120"], ["pro", "Pro · 180"], ["custom", "Custom"]] as const).map(([value, label]) =>
          <label key={value} className={s.idleChip}>
            <input type="radio" name="plan" checked={value === "custom" ? planCustom : !planCustom && values.plan === value}
              onChange={() => {
                save("plan", value === "custom" ? values.allowance : value);
              }} /><span>{label}</span>
          </label>)}
      </div>
      {planCustom ? <NumberSetting label="Core-hours per month" value={values.allowance} min={0} disabled={pending}
        valid={value => Number.isFinite(value) && value >= 0} save={value => save("plan", value)} suffix="core-hours / month" />
        : <small className={s.settingHint}>Core-hours per month. A 4-core phone uses 4 each hour.</small>}
    </fieldset>
  </div>;
}

function NumberSetting({ label, value, min, max, valid, save, disabled, suffix }: {
  label: string; value: number; min: number; max?: number; valid: (value: number) => boolean;
  save: (value: number) => void; disabled: boolean; suffix: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { setDraft(String(value)); }, [value, disabled]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  function schedule(text: string) {
    if (timer.current) clearTimeout(timer.current);
    if (!text.trim() || !valid(Number(text)) || Number(text) === value) return;
    timer.current = setTimeout(() => save(Number(text)), 500);
  }
  return <label className={s.idleCustom}>
    <input type="number" aria-label={label} min={min} max={max} step={max ? 1 : "any"} value={draft}
      disabled={disabled} onChange={event => {
        if (timer.current) clearTimeout(timer.current);
        setDraft(event.target.value);
      }} onBlur={() => schedule(draft)}
      onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); schedule(draft); } }} />
    <span>{suffix}</span>
  </label>;
}
