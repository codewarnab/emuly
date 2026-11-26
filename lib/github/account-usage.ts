import type { DatabaseQueries } from "../data/async-database.ts";
import { type BillingResult, planAllowance } from "./github-billing.ts";
import { QUOTA_ERROR_SQL, estimateUsage, monthStart, quotaBlocked, readMonthlyRuns, reconcileUsage } from "../data/usage.ts";
import { userSettings } from "../data/settings.ts";

type ReadBilling = (user: { id: number; login: string; scopes: string }) => Promise<BillingResult>;

/**
 * The dashboard usage card. The GitHub billing read and the Turso reads run together.
 * billing_settings.plan_name is written only when GitHub reports a plan that differs from the stored one,
 * so most page loads do no Turso write. On a change, the write runs first and the plan-based reads run again,
 * so the allowance on this page already matches the new plan.
 */
export async function loadAccountUsage(database: DatabaseQueries, readBilling: ReadBilling,
  user: { id: number; login: string }, clock = Date.now) {
  const now = clock();
  const savedPlan = () => database.execute({ sql: "SELECT plan_name, allowance_override FROM billing_settings WHERE user_id = ?", args: [user.id] });
  const scopesThenBilling = async () => {
    const scopes = String((await database.execute({ sql: "SELECT token_scopes FROM users WHERE id = ?", args: [user.id] })).rows[0]?.token_scopes ?? "");
    return readBilling({ ...user, scopes });
  };
  let [billing, saved, settings, runs, quotaError] = await Promise.all([
    scopesThenBilling(),
    savedPlan(),
    userSettings(database, user.id),
    readMonthlyRuns(database, user.id, now),
    database.execute({ sql: `SELECT max(ts) AS ts FROM events WHERE user_id = ? AND kind = 'error' AND ts >= ? AND ${QUOTA_ERROR_SQL}`,
      args: [user.id, monthStart(now)] }),
  ]);
  if (billing.plan && billing.plan !== saved.rows[0]?.plan_name) {
    await database.execute({ sql: `INSERT INTO billing_settings (user_id, plan_name) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET plan_name = excluded.plan_name`, args: [user.id, billing.plan] });
    [saved, settings] = await Promise.all([savedPlan(), userSettings(database, user.id)]);
  }
  const reportRuns = billing.usage && monthStart(now) !== monthStart(billing.checkedAt)
    ? await readMonthlyRuns(database, user.id, billing.checkedAt) : null;
  const row = saved.rows[0];
  const plan = typeof row?.plan_name === "string" ? row.plan_name : null;
  const localEstimate = estimateUsage(runs, settings.allowance_core_hours, () => now);
  // GitHub lags. Add only the live Emuly time accrued since this cached report.
  const atReport = billing.usage
    ? estimateUsage(reportRuns ?? runs, settings.allowance_core_hours, () => billing.checkedAt) : localEstimate;
  const usage = {
    ...localEstimate,
    ...reconcileUsage(localEstimate, atReport, billing.usage?.coreHours ?? null),
    billing, plan, overridden: row?.allowance_override != null,
    quota_blocked: quotaBlocked((quotaError.rows[0]?.ts as string | null) ?? null, runs),
    storage_included: planAllowance(plan).storageGbMonths,
  };
  return { usage, localEstimate, autoStop: settings.auto_stop_before_empty };
}
