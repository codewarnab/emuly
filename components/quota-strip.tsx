import s from "./console.module.css";
import { mockQuota } from "./fixtures";

export function QuotaStrip() {
  // TODO(Phase 3): replace fixture quota with usage estimates.
  const q = mockQuota;
  const pct = Math.round((q.usedHours / q.totalHours) * 100);
  return (
    <>
      <div className={s.strip} id="usage">
        <span className={s.lab}>Example estimated usage</span>
        <span className={s.big}>
          {q.usedHours} h <span className={s.bigSmall}>of {q.totalHours} h used</span>
        </span>
        <span className={s.track}>
          <i className={s.trackFill} style={{ width: `${pct}%` }} />
        </span>
        <a className={s.link} href="https://github.com/settings/billing" target="_blank" rel="noreferrer">
          GitHub usage
        </a>
      </div>
      <div className={s.fineprint}>
        <span>
          Your codespace keeps the phone when stopped.
        </span>
        <span>
          Only deleting the codespace erases the phone.
        </span>
        <span>
          GitHub stops an idle slot after <b>4 h</b>.
        </span>
      </div>
    </>
  );
}
