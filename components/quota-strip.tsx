import s from "./console.module.css";
import type { AccountUsage } from "../lib/billing";
import { quotaState } from "../lib/github-billing";
import { AllowanceChoice } from "./allowance-choice";

function Meter({ used, included, label, state, small = false }: {
  used: number; included: number; label: string; state: string; small?: boolean;
}) {
  return <span className={`${s.track} ${small ? s.storageTrack : ""}`} role="meter" aria-label={label}
    aria-valuemin={0} aria-valuemax={included || 1} aria-valuenow={Math.min(used, included || 1)}
    aria-valuetext={`${used.toFixed(1)} of ${included} used`}>
    <i className={`${s.trackFill} ${state === "paid" ? s.budgetPaid : state === "low" ? s.budgetWarning : s.budgetHealthy}`}
      style={{ width: `${included > 0 ? Math.min(100, used / included * 100) : 100}%` }} />
  </span>;
}

export function QuotaStrip({ usage, defaultCores = 4 }: { usage: AccountUsage; defaultCores?: number }) {
  const cores = Math.max(1, defaultCores);
  const used = usage.reported_core_hours;
  const included = usage.allowance_core_hours;
  const left = Math.max(0, included - used);
  const net = usage.billing.usage?.netAmount ?? 0;
  const storage = usage.billing.usage?.storageGbMonths;
  const state = quotaState(used, included, net);
  const storageState = quotaState(storage ?? 0, usage.storage_included, net);
  const status = net > 0 ? `You now pay ${net < 0.01 ? "<$0.01" : `$${net.toFixed(2)}`} this month`
    : state === "low" ? "20% or less of compute hours remain" : "Compute hours available";
  return <section id="usage" aria-label="Monthly Codespaces usage" className={s.budget}>
    <div className={s.strip}>
      <span className={s.big}>{(left / cores).toFixed(1)} of {(included / cores).toFixed(1)} hours left this month <span className={s.bigSmall}>(on a {cores}-core phone)</span></span>
      <Meter used={used / cores} included={included / cores} label="Phone hours used" state={state} />
      <a className={s.link} href="https://github.com/settings/billing/usage" target="_blank" rel="noreferrer">Open GitHub billing</a>
    </div>
    <p className={state === "paid" ? s.paidText : s.usageStatus} role="status">
      <span aria-hidden="true">{state === "healthy" ? "?" : "?"}</span> {status}
      <span className={s.usageSource}> ? {usage.billing.usage ? "GitHub billing" : "Estimate"}{usage.overridden ? " ? Override" : usage.plan ? ` ? GitHub ${usage.plan === "pro" ? "Pro" : "Free"}` : " ? Plan unverified"}</span>
    </p>
    {usage.billing.usage && <p className={s.usageStatus}>Phonelink used {(usage.phonelink_core_hours / cores).toFixed(1)} h ? other codespaces used {(usage.other_core_hours / cores).toFixed(1)} h</p>}
    <div className={s.storageRow}>
      <span>{storage === undefined ? "Storage unavailable" : `${storage.toFixed(2)} of ${usage.storage_included} GB-month used`}</span>
      {storage !== undefined && <Meter used={storage} included={usage.storage_included} label="Storage GB-month used" state={storageState} small />}
      {storage !== undefined && <span><span aria-hidden="true">{storageState === "healthy" ? "?" : "?"}</span> {storageState === "healthy" ? "Storage available" : storageState === "paid" ? "Paid usage this month" : "Storage allowance low"}</span>}
    </div>
    {usage.running.length > 0 && <p className={s.usageStatus}>Time left at current rate: about {usage.hours_left_at_current_rate?.toFixed(1)} h.</p>}
    <p className={s.fineprint}>{usage.billing.usage ? "Billing totals lag; the countdown includes live phone time." : "Estimate covers phonelink phones only."}</p>
    {!usage.billing.usage && <a className={`${s.btn} ${s.btnGhost} ${s.btnTiny} ${s.billingConnect}`} href="/auth/start?billing=1">Connect billing for exact numbers</a>}
    {usage.billing.unavailable === "temporary" && <p className={s.fineprint}>GitHub billing is temporarily unavailable. Try again later.</p>}
    <details className={s.allowance}>
      <summary aria-label="Usage information">? Usage details</summary>
      <p>Hours use a {cores}-core phone. The account allowance is shared across all codespaces. GitHub reports usage with a delay.</p>
      <p>{used.toFixed(1)} of {included} core-hours used. Remaining: {left.toFixed(1)} core-hours.</p>
      <p>Phonelink uses a UTC calendar month. Other usage is GitHub?s total minus phonelink?s estimate, clamped to zero.</p>
      {!usage.plan && <p>The plan is unverified. The default is the Free allowance until GitHub supplies your plan.</p>}
      {usage.billing.usage && <p>Gross: ${usage.billing.usage.grossAmount.toFixed(2)} ? discounts: ${usage.billing.usage.discountAmount.toFixed(2)} ? net: ${net.toFixed(2)}.</p>}
      <p>Connecting billing requests GitHub?s optional user scope. You can decline and keep using estimates.</p>
    </details>
    <AllowanceChoice allowance={included} />
  </section>;
}
