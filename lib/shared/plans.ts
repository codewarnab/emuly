/** GitHub's monthly free codespace core-hours for each plan. A 4-core phone uses 4 per hour. */
export const PLANS = {
  free: { name: "GitHub Free", coreHours: 120 },
  pro: { name: "GitHub Pro", coreHours: 180 },
} as const;
export type PlanId = keyof typeof PLANS;

/** Phone hours per month for a plan on a phone with `cores` cores. */
export const phoneHours = (plan: PlanId, cores = 4) => PLANS[plan].coreHours / cores;

/** GitHub's codespace usage page. */
export const GITHUB_BILLING_URL = "https://github.com/settings/billing/usage";
/** GitHub's plan page. */
export const GITHUB_PLAN_URL = "https://github.com/settings/billing";
