import "server-only";
import { asyncDb } from "../data/async-db.ts";
import { getAccessToken } from "./github-token.ts";
import { createBillingClient, planAllowance } from "./github-billing.ts";
import { QUOTA_ERROR_SQL, estimateUsage, monthStart, quotaBlocked, readMonthlyRuns, reconcileUsage } from "../data/usage.ts";
import { userSettings } from "../data/settings.ts";

const global = globalThis as unknown as { __billing?: ReturnType<typeof createBillingClient> };
export const billingClient = global.__billing ??= createBillingClient({ accessToken: getAccessToken });

export async function readAccountUsage(user: { id: number; login: string }, clock = Date.now) {
  const database = asyncDb();
  const scopes = String((await database.execute({ sql: "SELECT token_scopes FROM users WHERE id = ?", args: [user.id] })).rows[0]?.token_scopes ?? "");
  const billing = await billingClient.read({ ...user, scopes });
  if (billing.plan) {
    await database.execute({ sql: `INSERT INTO billing_settings (user_id, plan_name) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET plan_name = excluded.plan_name`, args: [user.id, billing.plan] });
  }
  const now = clock();
  const [saved, settings, runs, reportRuns, quotaError] = await Promise.all([
    database.execute({ sql: "SELECT plan_name, allowance_override FROM billing_settings WHERE user_id = ?", args: [user.id] }),
    userSettings(database, user.id),
    readMonthlyRuns(database, user.id, now),
    billing.usage && monthStart(now) !== monthStart(billing.checkedAt)
      ? readMonthlyRuns(database, user.id, billing.checkedAt) : null,
    database.execute({ sql: `SELECT max(ts) AS ts FROM events WHERE user_id = ? AND kind = 'error' AND ts >= ? AND ${QUOTA_ERROR_SQL}`,
      args: [user.id, monthStart(now)] }),
  ]);
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

export type AccountUsage = Awaited<ReturnType<typeof readAccountUsage>>["usage"];
