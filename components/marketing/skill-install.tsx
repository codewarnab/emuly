"use client";
import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { SKILL_AGENTS, skillInstallPrompt } from "../../lib/skill-install-prompt";
import s from "./skill-install.module.css";

/** A quiet link next to the hero note. It opens a dialog with a prompt that installs the skill only. */
const logo = (f: string) => `/agents/${f.includes(".") ? f : `${f}.svg`}`;

export function SkillInstall() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={s.link} onClick={() => setOpen(true)}>Just the skill?</button>
    {open && <Dialog title="Install the Emuly skill" close={() => setOpen(false)}>
      <p className={s.sub}>Paste this prompt into your agent. It finds its skills folder and asks before it installs.</p>
      <div className={s.copy}><CopyButton text={skillInstallPrompt()} label="Copy install prompt" /></div>
      <p className={s.label}>Works with all of these</p>
      <div className={s.marquee}>
        <ul className={s.track}>
          {[...SKILL_AGENTS, ...SKILL_AGENTS].map((a, i) => <li key={i} aria-hidden={i >= SKILL_AGENTS.length || undefined}>
            <img src={logo(a.light)} alt="" className={s.onLight} width={18} height={18} />
            <img src={logo(a.dark)} alt="" className={s.onDark} width={18} height={18} />
            {a.name}
          </li>)}
        </ul>
      </div>
    </Dialog>}
  </>;
}
