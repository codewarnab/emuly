import { CopyButton } from "./copy-button";
import { AGENT_PROMPT } from "../lib/agent-prompt";
import s from "./console.module.css";

export function EmptyState({ title, sub }: { title: string; sub: string }) {
  return (
    <div className={s.emptyDashed}>
      <div className={s.emptyPhone} aria-hidden="true" />
      <div className={s.emptyTitle}>{title}</div>
      <div className={s.emptySub}>{sub}</div>
      <CopyButton text={AGENT_PROMPT} label="Copy prompt" />
    </div>
  );
}
