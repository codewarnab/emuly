import { CopyButton } from "./copy-button";
import { NewPhone } from "./phone-mutations";
import { AGENT_PROMPT } from "../lib/agent-prompt";
import type { Usage } from "../lib/usage";
import s from "./console.module.css";

/** First visit: two clear ways to get a phone. */
export function EmptyPhones({ usage }: { usage: Usage }) {
  return <section className={s.emptyPhones} aria-labelledby="empty-title">
    <div className={s.emptyPhonesArt} aria-hidden="true"><i /><i /><i /></div>
    <h2 id="empty-title">Get your first phone</h2>
    <p>An Android phone in your own GitHub. Ready in about 5 minutes.</p>
    <div className={s.emptyActions}>
      <NewPhone usage={usage} />
      <span className={s.emptyOr}>or let your agent do it</span>
      <CopyButton text={AGENT_PROMPT} label="Copy prompt" />
    </div>
  </section>;
}
