import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { Brand } from "@/components/shell/topbar";
import { CopyButton } from "@/components/ui/copy-button";
import { SELF_HOST_SETUP_PROMPT } from "../../../lib/selfhost-setup-prompt";
import s from "./self-host.module.css";

export const metadata: Metadata = {
  title: "Self-host Emuly",
  description: "Run Emuly on your own machine. Your coding agent does the setup.",
  alternates: { canonical: "/self-host", types: { "text/markdown": "/self-host.md" } },
};

const GH = "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z";

const ICONS = {
  prompt: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M7 9l3 3-3 3M12 15h5" /></svg>,
  docker: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.5 11.5h17.2c.6-1.3 1.9-1.9 3.3-1.6-.2 1.2-1 2-2.1 2.3C19.6 17 15.8 20 10.6 20 5.6 20 2.6 16.8 2.5 11.5z" /><g opacity=".85"><rect x="4.4" y="8.4" width="2.6" height="2.4" rx=".3" /><rect x="7.6" y="8.4" width="2.6" height="2.4" rx=".3" /><rect x="10.8" y="8.4" width="2.6" height="2.4" rx=".3" /><rect x="14" y="8.4" width="2.6" height="2.4" rx=".3" /><rect x="7.6" y="5.4" width="2.6" height="2.4" rx=".3" /><rect x="10.8" y="5.4" width="2.6" height="2.4" rx=".3" /><rect x="10.8" y="2.4" width="2.6" height="2.4" rx=".3" /></g></svg>,
  github: <svg viewBox="0 0 16 16" fill="currentColor"><path d={GH} /></svg>,
  phone: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="2.5" /><path d="M9.5 12l2 2 3.5-3.5" /></svg>,
};

const STEPS = [
  { who: "You", title: "Paste the prompt", icon: ICONS.prompt },
  { who: "Agent", title: "Runs Docker", icon: ICONS.docker },
  { who: "You", title: "Sign in to GitHub", icon: ICONS.github },
  { who: "Agent", title: "Phones ready", icon: ICONS.phone },
];

export default function SelfHostPage() {
  return <div className={s.root}>
    <nav className={s.nav} aria-label="Main"><Brand /><div><ThemeToggle /><Link href="/">Home</Link></div></nav>
    <main id="main-content" tabIndex={-1} className={s.wrap}>
      <h1>Self-host Emuly</h1>
      <p className={s.lead}>Your agent sets it up. You sign in.</p>
      <CopyButton text={SELF_HOST_SETUP_PROMPT} label="Copy setup prompt" />

      <ol className={s.steps}>
        {STEPS.map((step, i) => <li key={step.title} className={step.who === "You" ? s.you : s.agent}>
          <span className={s.icon} aria-hidden="true">{step.icon}<span className={s.num}>{i + 1}</span></span>
          <span className={s.who}>{step.who}</span>
          <strong>{step.title}</strong>
        </li>)}
      </ol>

      <p className={s.more}><a href="https://github.com/codewarnab/emuly/blob/main/docs/SELF-HOST.md" target="_blank" rel="noopener noreferrer">Manual guide</a></p>
    </main>
  </div>;
}
