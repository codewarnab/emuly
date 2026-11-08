import Link from "next/link";
import s from "@/components/console.module.css";
import type { AccountUsage } from "@/lib/github/billing";
import { quotaState } from "@/lib/github/github-billing";

export function QuotaStrip({ usage, defaultCores = 4 }: { usage: AccountUsage; defaultCores?: number }) {
  const cores = Math.max(1, defaultCores);
  const used = usage.reported_core_hours;
  const included = usage.allowance_core_hours;
  const left = Math.max(0, included - used);
  const net = usage.billing.usage?.netAmount ?? 0;
  const state = quotaState(used, included, net);
  const planName = usage.overridden ? "Custom allowance" : usage.plan === "pro" ? "GitHub Pro" : "GitHub Free";
  const fill = state === "paid" ? s.budgetPaid : state === "low" ? s.budgetWarning : s.budgetHealthy;
  return <section id="usage" aria-label="Monthly Codespaces usage" className={s.budget}>
    <div className={s.strip}>
      <span className={s.big}>
        {(left / cores).toFixed(1)} of {(included / cores).toFixed(1)} hours left
        {state === "low" && <span className={s.bigSmall}> · running low</span>}
        {state === "paid" && <span className={s.bigSmall}> · you now pay ${net.toFixed(2)}</span>}
      </span>
      <span className={s.track} role="meter" aria-label="Hours used this month" aria-valuemin={0}
        aria-valuemax={included || 1} aria-valuenow={Math.min(used, included || 1)}
        aria-valuetext={`${(used / cores).toFixed(1)} of ${(included / cores).toFixed(1)} hours used`}>
        <i className={`${s.trackFill} ${fill}`} style={{ width: `${included > 0 ? Math.min(100, used / included * 100) : 100}%` }} />
      </span>
    </div>
    <p className={s.usageMeta}>
      {planName} · {cores}-core phone{usage.running.length > 0 && usage.hours_left_at_current_rate !== null
        && ` · about ${usage.hours_left_at_current_rate.toFixed(1)} h at current rate`}
      {" · "}<Link href="/app/welcome">Change plan</Link>
      {" · "}<a href="https://github.com/settings/billing/usage" target="_blank" rel="noreferrer">GitHub billing</a>
    </p>
  </section>;
}
