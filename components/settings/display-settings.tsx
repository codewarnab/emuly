"use client";

import { useState, useTransition } from "react";
import { saveDisplayQuality } from "@/app/actions/settings";
import type { StreamQuality } from "@/lib/shared/display-settings";
import s from "@/components/console.module.css";

export function DisplaySettings({ initial }: { initial: StreamQuality }) {
  const [quality, setQuality] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState("");
  return <div className={`${s.createForm} ${s.hoursForm}`}>
    <fieldset className={s.idleField} disabled={pending}>
      <legend>Stream quality</legend>
      <p className={s.settingHint}>Applies to all your phones. Auto adjusts to your connection.</p>
      <div className={s.idleChoices}>
        {([
          ["auto", "Auto", "Recommended · adapts to your connection"],
          ["sharp", "Sharp", "Higher bit rate · sharper detail"],
          ["saver", "Saver", "Smaller picture · 15 fps · lower bandwidth"],
        ] as const).map(([value, label, detail]) => <label key={value} className={s.idleChip} title={detail}>
          <input type="radio" name="stream-quality" value={value} checked={quality === value}
            aria-label={`${label}: ${detail}`} onChange={() => {
              setStatus("Saving…");
              startTransition(async () => {
                try {
                  const result = await saveDisplayQuality(value);
                  if (result.ok) setQuality(value);
                  setStatus(result.message);
                } catch { setStatus("Settings could not be saved. Try again."); }
              });
            }} /><span>{label}</span>
        </label>)}
      </div>
      <p className={s.settingHint}>{quality === "auto" ? "Auto · recommended" : quality === "sharp" ? "Sharp · higher bit rate" : "Saver · smaller picture at 15 fps"}</p>
    </fieldset>
    <p role="status" className={s.saveStatus}>{status}</p>
  </div>;
}
