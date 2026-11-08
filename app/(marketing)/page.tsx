import Link from "next/link";
import { Suspense } from "react";
import { getSession } from "../../lib/session";
import type { Metadata } from "next";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { Brand } from "@/components/shell/topbar";
import { CopyButton } from "@/components/ui/copy-button";
import { KeyboardTools } from "@/components/shell/keyboard-tools";
import { HeroPhone } from "@/components/marketing/hero-phone";
import { AGENT_PROMPT } from "../../lib/agent-prompt";
import s from "./landing.module.css";

export const metadata: Metadata = {
  title: "phonelink — a free Android emulator in the cloud",
  description: "Run an Android emulator in the cloud, for free. Use the Codespaces hours included in your GitHub plan. Paste one prompt into your coding agent.",
};

const AGENTS = [
  { name: "Claude Code", light: "claude-ai-icon", dark: "claude-ai-icon" },
  { name: "Codex", light: "openai", dark: "openai_dark" },
  { name: "Cursor", light: "cursor_light", dark: "cursor_dark" },
  { name: "T3 Code", light: "t3-dark", dark: "t3-light" },
  { name: "OpenCode", light: "opencode", dark: "opencode-dark" },
];

export default function LandingPage() {
  return <div className={s.root}>
    <KeyboardTools />
    <nav className={s.nav} aria-label="Main"><Brand /><div><ThemeToggle /><Suspense fallback={<Link href="/login">Sign in</Link>}><NavAuth /></Suspense></div></nav>
    <main id="main-content" tabIndex={-1} className={s.wrap}>
      <section className={s.hero}>
        <div>
          <h1>Run an Android emulator in the cloud.<br />Free.</h1>
          <p className={s.lead}>It runs in your own GitHub Codespace, on the hours your GitHub plan already includes, so there is nothing to pay.</p>
          <div className={s.cta}><CopyButton text={AGENT_PROMPT} label="Copy prompt" /></div>
          <p className={s.note}>Paste it into any coding agent. It asks you for anything it needs.</p>
          <ul className={s.agents} aria-label="Works with">
            {AGENTS.map(a => <li key={a.name}>
              <img src={`/agents/${a.light}.svg`} alt="" className={s.onLight} width={20} height={20} />
              <img src={`/agents/${a.dark}.svg`} alt="" className={s.onDark} width={20} height={20} />
              {a.name}
            </li>)}
          </ul>
        </div>
        <div className={s.device}><HeroPhone /></div>
      </section>
      <section className={s.facts} aria-label="The essentials">
        <p>Free on your included Codespaces hours. No card.</p>
        <p>Stopping is safe. Only deleting the codespace erases the phone.</p>
        <p>Watch and touch your phone in your browser.</p>
      </section>
      <section className={s.faq} aria-label="Common questions">
        <h2>A few things to know</h2>
        <div>
          <details><summary>Is it really free?</summary><p>Yes. You bring the compute through the Codespaces hours included in your GitHub plan. Phonelink never bills you or resells GitHub. Stay within your included hours to avoid GitHub charges.</p></details>
          <details><summary>What does it need from GitHub?</summary><p>One permission: Codespaces. No repo access. Your agent asks you to sign in when it needs approval.</p></details>
          <details><summary>What happens when I stop it?</summary><p>Your codespace keeps the phone. It resumes in about 15 seconds. Only deleting the codespace erases it. GitHub deletes a stopped phone after its retention period. New phones get 30 days after the last stop. The console shows each phone&apos;s countdown.</p></details>
          <details><summary>Limits?</summary><p>Running phones share your hours. GitHub decides how many codespaces you can have and run. GitHub stops an idle phone after 30 minutes or 4 hours, your choice. Cold boot takes 63–157 seconds. Hours shown in the console are estimates.</p></details>
        </div>
      </section>
    </main>
    <footer className={s.footer}>phonelink — your codespace, your phone.</footer>
  </div>;
}

async function NavAuth() {
  const session = await getSession();
  return session ? <Link href="/app">Console</Link> : <Link href="/login">Sign in</Link>;
}
