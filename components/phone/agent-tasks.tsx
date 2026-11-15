"use client";
import { useState, type ReactNode } from "react";
import { copyPending, freshPrompt } from "@/components/ui/copy-button";
import { copyText, useToast } from "@/components/ui/ui-provider";
import s from "./agent-tasks.module.css";

/** One-click prompts that already name this phone. Each copy fetches a fresh setup prompt,
    so an agent with no Emuly key can still start, then appends the task. */
export type PhoneMood = "ready" | "starting" | "stopped";

const icon = (d: ReactNode) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;

const TASKS: { id: string; title: string; icon: ReactNode; task: string }[] = [
  { id: "test", title: "Test my app", icon: icon(<><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3" /><path d="M7.5 14h9" /></>),
    task: "Build the Android app in my current project, install it on this phone, open it, and test the main flows. Report each problem with a screenshot." },
  { id: "install", title: "Install an APK", icon: icon(<><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" /></>),
    task: "Install an APK on this phone and open it. Ask me for the file path or URL." },
  { id: "drive", title: "Drive the phone", icon: icon(<><rect x="6" y="2.5" width="12" height="19" rx="2.5" /><path d="M11 18h2" /><path d="M10 9.5l4 2.5-4 2.5z" /></>),
    task: "Drive this phone for me. Take a screenshot, then ask me what to do." }
];

const LEAD: Record<PhoneMood, string> = {
  ready: "",
  starting: "The phone is starting. Wait until Android is ready.\n",
  stopped: "The phone is stopped. Wake it first and wait until Android is ready.\n",
};

export function AgentTasks({ id, name, mood, base }: { id: string; name: string; mood: PhoneMood; base: string }) {
  const notify = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function copy(taskId: string, task: string) {
    setBusy(taskId);
    const tail = `\n\nThen use my Emuly phone "${name}" (id ${id}) at ${base}. Read ${base}/agent.md if you need the API.\n${LEAD[mood]}Task: ${task}`;
    const full = freshPrompt().then(f => ({ ...f, prompt: f.prompt + tail }));
    full.catch(() => {});
    try {
      let early = false;
      try { early = await copyPending(full.then(f => f.prompt)); } catch { early = false; }
      const { prompt } = await full;
      if (early) notify("Prompt copied. Paste it into your agent.");
      else if (!(await copyText(prompt, notify, "Prompt copied. Paste it into your agent"))) return;
      setDone(taskId); setTimeout(() => setDone(d => (d === taskId ? null : d)), 2500);
    } catch (error) { notify(error instanceof Error ? error.message : "Could not copy the prompt."); }
    finally { setBusy(null); }
  }

  return <section className={s.panel} aria-label="Hand this phone to your agent">
    <h2>Copy a prompt for your agent:</h2>
    <div className={s.grid}>
      {TASKS.map(t => <button key={t.id} type="button" className={s.card}
        disabled={busy !== null} aria-busy={busy === t.id || undefined} onClick={() => copy(t.id, t.task)}>
        <span className={s.icon}>{t.icon}</span>
        <span className={s.title}>{busy === t.id ? "Preparing…" : done === t.id ? "Copied ✓" : t.title}</span>
      </button>)}
    </div>
  </section>;
}
