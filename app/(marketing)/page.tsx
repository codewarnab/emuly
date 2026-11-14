import Link from "next/link";
import { Suspense } from "react";
import { getSession } from "../../lib/auth/session";
import type { Metadata } from "next";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { Brand } from "@/components/shell/topbar";
import { CopyButton } from "@/components/ui/copy-button";
import { KeyboardTools } from "@/components/shell/keyboard-tools";
import { SkillInstall } from "@/components/marketing/skill-install";
import { HeroPhone } from "@/components/marketing/hero-phone";
import { AGENT_PROMPT } from "../../lib/agent-prompt-text";
import s from "./landing.module.css";

const logo = (f: string) => `/agents/${f.includes(".") ? f : `${f}.svg`}`;

export const metadata: Metadata = {
  title: "Emuly — a free Android emulator in the cloud",
  description: "Run an Android emulator in the cloud, for free. Use the Codespaces hours included in your GitHub plan. Paste one prompt into your coding agent.",
};

const AGENTS = [
  { name: "Claude Code", light: "claude-ai-icon", dark: "claude-ai-icon" },
  { name: "Codex", light: "openai", dark: "openai_dark" },
  { name: "Cursor", light: "cursor_light", dark: "cursor_dark" },
  { name: "T3 Code", light: "t3-dark", dark: "t3-light" },
  { name: "OpenCode", light: "opencode", dark: "opencode-dark" },
  { name: "Pi", light: "pi-light", dark: "pi-dark" },
  { name: "Amp", light: "amp", dark: "amp" },
  { name: "Devin", light: "devin", dark: "devin" },
  { name: "Cline", light: "cline", dark: "cline-dark" },
  { name: "Roo Code", light: "roocode", dark: "roocode-dark" },
  { name: "Kiro", light: "kiro", dark: "kiro" },
  { name: "Goose", light: "goose", dark: "goose-dark" },
  { name: "OpenHands", light: "openhands", dark: "openhands" },
  { name: "Trae", light: "trae", dark: "trae" },
  { name: "OpenClaw", light: "openclaw", dark: "openclaw" },
  { name: "Hermes Agent", light: "hermes.png", dark: "hermes.png" },
  { name: "Gemini CLI", light: "gemini", dark: "gemini" },
  { name: "GitHub Copilot", light: "copilot", dark: "copilot_dark" },
  { name: "Windsurf", light: "windsurf-light", dark: "windsurf-dark" },
  { name: "Zed", light: "zed-logo", dark: "zed-logo_dark" },
  { name: "Antigravity", light: "antigravity", dark: "antigravity" },
  { name: "Kilo Code", light: "kilocode-light", dark: "kilocode-dark" },
  { name: "Qwen Code", light: "qwen_light", dark: "qwen_dark" },
  { name: "Warp", light: "warp", dark: "warp" },
  { name: "VS Code", light: "vscode", dark: "vscode" },
  { name: "JetBrains", light: "jetbrains", dark: "jetbrains" },
  { name: "Replit", light: "replit", dark: "replit" },
];

export default function LandingPage() {
  return <div className={s.root}>
    <KeyboardTools />
    <nav className={s.nav} aria-label="Main"><Brand /><div><ThemeToggle /><Suspense fallback={<NavAuthPlaceholder />}><NavAuth /></Suspense></div></nav>
    <main id="main-content" tabIndex={-1} className={s.wrap}>
      <section className={s.hero}>
        <div>
          <h1>Run an Android emulator in the cloud.<br />Free.</h1>
          <p className={s.lead}>It runs in your own GitHub Codespace, on the hours your GitHub plan already includes, so there is nothing to pay.</p>
          <div className={s.cta}><CopyButton text={AGENT_PROMPT} label="Copy prompt" /><a className={s.gh} href="https://github.com/codewarnab/emuly" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>Open source</a></div>
          <div className={s.note}>Paste it into any coding agent. <SkillInstall /></div>
          <div className={s.marquee} aria-label="Works with">
            <ul className={s.track}>
              {[...AGENTS, ...AGENTS].map((a, i) => <li key={i} aria-hidden={i >= AGENTS.length || undefined}>
                <img src={logo(a.light)} alt="" className={s.onLight} width={20} height={20} />
                <img src={logo(a.dark)} alt="" className={s.onDark} width={20} height={20} />
                {a.name}
              </li>)}
            </ul>
          </div>
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
          <details><summary>Is it really free?</summary><p>Yes. You bring the compute through the Codespaces hours included in your GitHub plan. Emuly never bills you or resells GitHub. Stay within your included hours to avoid GitHub charges.</p></details>
          <details><summary>What does it need from GitHub?</summary><p>One permission: Codespaces. No repo access. Your agent asks you to sign in when it needs approval.</p></details>
          <details><summary>What happens when I stop it?</summary><p>Your codespace keeps the phone. Waking it boots Android fresh, which takes a few minutes. Only deleting the codespace erases it. GitHub deletes a stopped phone after its retention period. New phones get 30 days after the last stop. The console shows each phone&apos;s countdown.</p></details>
          <details><summary>Is it fast?</summary><p>Yes. Android runs with hardware acceleration (KVM) on the codespace machine. It is not slow software emulation, so apps open and respond quickly.</p></details>
          <details><summary>Limits?</summary><p>Running phones share your hours. GitHub decides how many codespaces you can have and run. GitHub stops an idle phone after 30 minutes or 4 hours, your choice. Cold boot takes about 2 minutes. Hours shown in the console are estimates.</p></details>
        </div>
      </section>
    </main>
    <footer className={s.footer}>Emuly — your codespace, your phone.</footer>
  </div>;
}

/** Holds the space while the session streams in. It never shows "Sign in", because the
    session is not known yet and a signed-in user must not see a wrong link. */
function NavAuthPlaceholder() {
  return <span aria-hidden="true" style={{ visibility: "hidden" }}>Console</span>;
}

async function NavAuth() {
  const session = await getSession();
  return session ? <Link href="/app">Console</Link> : <Link href="/login">Sign in</Link>;
}
