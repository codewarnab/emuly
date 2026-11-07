import s from "./console.module.css";
import type { Usage } from "../lib/usage";
import { AllowanceChoice } from "./allowance-choice";

export function QuotaStrip({ usage, defaultCores = 4 }: { usage: Usage; defaultCores?: number }) {
  const left = Math.max(0, usage.allowance_core_hours - usage.used_core_hours);
  const pct = usage.allowance_core_hours > 0 ? Math.min(100, usage.used_core_hours / usage.allowance_core_hours * 100) : 100;
  return <section id="usage" aria-label="Estimated hours budget" className={s.budget}>
    <div className={s.strip}>
      <span className={s.big}>About {(left / defaultCores).toFixed(1)} h <span className={s.bigSmall}>left this month</span></span>
      <span className={s.track} role="meter" aria-label="Estimated core-hours used" aria-valuemin={0} aria-valuemax={usage.allowance_core_hours || 1} aria-valuenow={Math.min(usage.used_core_hours, usage.allowance_core_hours)}>
        <i className={`${s.trackFill} ${left < usage.allowance_core_hours * .1 || left === 0 ? s.budgetWarning : ""}`} style={{ width: `${pct}%` }} />
      </span>
      <a className={s.link} href="https://github.com/settings/billing/usage" target="_blank" rel="noreferrer">Check exact usage on GitHub</a>
    </div>
    {usage.running.length > 0 && <p>{usage.running.length} phones running. At this rate the hours last about {usage.hours_left_at_current_rate?.toFixed(1)} h.</p>}
    <p className={s.fineprint}>Estimated from phonelink phones only. Your other codespaces use the same hours.</p>
    <p className={s.fineprint}>Based on {defaultCores}-core machines and an allowance of {usage.allowance_core_hours} core-hours. One core-hour means one CPU core running for one hour.</p>
    <AllowanceChoice allowance={usage.allowance_core_hours} />
  </section>;
}
