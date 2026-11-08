import "server-only";
import { db } from "../data/db.ts";
import { getAccessToken } from "./github-token.ts";
import { createBillingClient, planAllowance } from "./github-billing.ts";
import { readUsage, reconcileUsage } from "../data/usage.ts";

const global = globalThis as unknown as { __billing?: ReturnType<typeof createBillingClient> };
export const billingClient = global.__billing ??= createBillingClient({ accessToken: getAccessToken });

export async function readAccountUsage(user: { id: number; login: string }, clock = Date.now) {
  const database = db();
  const scopes = String(database.prepare("SELECT token_scopes FROM users WHERE id = ?").get(user.id)?.token_scopes ?? "");
  const billing = await billingClient.read({ ...user, scopes });
  if (billing.plan) {
    database.prepare(`INSERT INTO billing_settings (user_id, plan_name) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET plan_name = excluded.plan_name`).run(user.id, billing.plan);
  }
  const saved = database.prepare("SELECT plan_name, allowance_override FROM billing_settings WHERE user_id = ?").get(user.id);
  const plan = typeof saved?.plan_name === "string" ? saved.plan_name : null;
  const estimate = readUsage(database, user.id, clock);
  // GitHub lags. Add only the live phonelink time accrued since this cached report.
  const atReport = readUsage(database, user.id, () => billing.checkedAt);
  return {
    ...estimate,
    ...reconcileUsage(estimate, atReport, billing.usage?.coreHours ?? null),
    billing, plan, overridden: saved?.allowance_override != null,
    storage_included: planAllowance(plan).storageGbMonths,
  };
}

export type AccountUsage = Awaited<ReturnType<typeof readAccountUsage>>;
