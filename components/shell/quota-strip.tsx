import Link from "next/link";
import s from "@/components/console.module.css";
import type { AccountUsage } from "@/lib/github/billing";
import { quotaState } from "@/lib/github/github-billing";
import { InfoTip } from "@/components/ui/info-tip";

export function QuotaStrip({ usage, defaultCores = 4 }: { usage: AccountUsage; defaultCores?: number }) {
  const cores = Math.max(1, defaultCores);
  const used = usage.reported_core_hours;
  const included = usage.allowance_core_hours;
  // GitHub refused a start for billing. Its count wins over the Emuly-only estimate.
  const blocked = usage.quota_blocked;
  const left = blocked ? 0 : Math.max(0, included - used);
  const net = usage.billing.usage?.netAmount ?? 0;
  const state = quotaState(used, included, net);
  const planName = usage.overridden ? "Custom allowance" : usage.plan === "pro" ? "GitHub Pro" : "GitHub Free";
  const fill = blocked ? s.budgetPaid : state === "paid" ? s.budgetPaid : state === "low" ? s.budgetWarning : s.budgetHealthy;
  return <section id="usage" aria-label="Monthly Codespaces usage" className={s.budget}>
    <div className={s.strip}>
      <span className={s.big}>
        {(left / cores).toFixed(1)} of {(included / cores).toFixed(1)} hours left
        {/* Login asks only for the codespace scope, so the billing report is usually unavailable. */}
        {blocked && <span className={s.bigSmall}> · GitHub blocked the last start</span>}
        {!usage.billing.usage && <> <InfoTip label="How hours are counted">
          {blocked ? "GitHub said your Codespaces hours or spending limit ran out. Codespaces you use outside Emuly count too. See GitHub billing for your full usage."
            : "Counts only phones you run in Emuly. Codespaces you use outside Emuly do not show here. See GitHub billing for your full usage."}
        </InfoTip></>}
        {!blocked && state === "low" && <span className={s.bigSmall}> · running low</span>}
        {state === "paid" && <span className={s.bigSmall}> · you now pay ${net.toFixed(2)}</span>}
      </span>
      <span className={s.track} role="meter" aria-label="Hours used this month" aria-valuemin={0}
        aria-valuemax={included || 1} aria-valuenow={blocked ? included || 1 : Math.min(used, included || 1)}
        aria-valuetext={blocked ? "No hours left, GitHub blocked the last start" : `${(used / cores).toFixed(1)} of ${(included / cores).toFixed(1)} hours used`}>
        <i className={`${s.trackFill} ${fill}`} style={{ width: `${blocked ? 100 : included > 0 ? Math.min(100, used / included * 100) : 100}%` }} />
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
