"use client";
import { useEffect, useState } from "react";
import { CopyButton } from "@/components/ui/copy-button";
import { copyText, useToast } from "@/components/ui/ui-provider";
import { AGENT_DOCS, OPERATING_SYSTEMS, findAgent, setupMarkdown, type OsId } from "@/lib/docs/agent-setup";
import s from "./docs.module.css";

type View = "human" | "agent";

/** The URL hash holds the state, for example #codex/linux/agent, so links open the same view. */
function readHash() {
  const [agent, os, view] = window.location.hash.slice(1).split("/");
  return {
    agent: findAgent(agent)?.id,
    os: OPERATING_SYSTEMS.find(item => item.id === os)?.id,
    view: view === "agent" || view === "human" ? view as View : undefined,
  };
}

function AgentIcon({ icon, size }: { icon: { light: string; dark: string }; size: number }) {
  return <>
    <img src={`/agents/${icon.light}.svg`} alt="" className={`${s.icon} ${s.onLight}`} width={size} height={size} />
    <img src={`/agents/${icon.dark}.svg`} alt="" className={`${s.icon} ${s.onDark}`} width={size} height={size} />
  </>;
}

/** A plain icon button for the machine view. The app's blue Button does not fit there. */
function MachineCopy({ text }: { text: string }) {
  const notify = useToast();
  const [copied, setCopied] = useState(false);
  return <button type="button" className={s.machineCopy} aria-label={copied ? "Copied" : "Copy all text"}
    onClick={async () => { if (await copyText(text, notify, "Copied")) { setCopied(true); setTimeout(() => setCopied(false), 2000); } }}>
    {copied
      ? <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      : <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M11 3.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h.5" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>}
  </button>;
}

export function SetupDocs({ nav }: { nav: React.ReactNode }) {
  const [agentId, setAgentId] = useState(AGENT_DOCS[0]!.id);
  const [os, setOs] = useState<OsId>("windows");
  const [view, setView] = useState<View>("human");

  useEffect(() => {
    const fromHash = readHash();
    if (fromHash.agent) setAgentId(fromHash.agent);
    if (fromHash.os) setOs(fromHash.os);
    if (fromHash.view) setView(fromHash.view);
  }, []);
  useEffect(() => { history.replaceState(null, "", `#${agentId}/${os}/${view}`); }, [agentId, os, view]);

  const agent = findAgent(agentId)!;
  const steps = agent.steps[os];
  const reader = <div className={s.reader} role="radiogroup" aria-label="Reader">
    {(["human", "agent"] as const).map(item => <button key={item} type="button" role="radio" aria-checked={view === item}
      onClick={() => setView(item)}><span className={s.dot} aria-hidden="true" />{item}</button>)}
  </div>;

  if (view === "agent") {
    const markdown = setupMarkdown();
    return <div className={s.machine}>
      <MachineCopy text={markdown} />
      <main id="main-content" tabIndex={-1} className={s.machineText}>
        <pre>{markdown}</pre>
        <pre>{"Raw Markdown: [/docs/setup.md](/docs/setup.md)"}</pre>
      </main>
      {reader}
    </div>;
  }

  return <div className={s.root}>
    <nav className={s.nav} aria-label="Main">{nav}</nav>
    <div className={s.layout}>
    <aside className={s.side}>
      <p className={s.sideLabel}>Coding agents</p>
      <nav aria-label="Coding agents">
        {AGENT_DOCS.map(item => <button key={item.id} type="button" aria-current={item.id === agentId ? "page" : undefined}
          className={s.sideLink} onClick={() => setAgentId(item.id)}><AgentIcon icon={item.icon} size={18} />{item.name}</button>)}
      </nav>
    </aside>

    <main id="main-content" tabIndex={-1} className={s.main}>
      <div className={s.header}>
        <div>
          <h1 className={s.title}><AgentIcon icon={agent.icon} size={30} />{agent.name}</h1>
          <p className={s.dim}>{agent.summary}</p>
        </div>
      </div>

      <div className={s.osTabs} role="group" aria-label="Operating system">
        {OPERATING_SYSTEMS.map(item => <button key={item.id} type="button" aria-pressed={os === item.id}
          disabled={!item.ready} onClick={() => setOs(item.id)}>
          {item.name}{!item.ready && <span className={s.soon}>Soon</span>}
        </button>)}
      </div>

      <ol className={s.steps}>
        {steps?.map((step, index) => <li key={index}>
          <h2>{step.title}</h2>
          {step.text && <p>{step.text}</p>}
          {step.code && <div className={s.code}><pre><code>{step.code}</code></pre><CopyButton text={step.code} description={`Copy command: ${step.code}`} /></div>}
        </li>)}
      </ol>
    </main>
    </div>
    {reader}
  </div>;
}
