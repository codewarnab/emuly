import type { Client } from "@libsql/client";
import type { DatabaseQueries } from "./async-database.ts";
import { userSettings, updateSettings } from "./settings.ts";
export { userSettings } from "./settings.ts";

export type Run = { phone_id: string; cores: number; started_at: string; stopped_at: string | null };
export type Usage = ReturnType<typeof estimateUsage>;

/** Keep billing totals separate from the live estimate so the countdown cannot double-count phone time. */
export function reconcileUsage(estimate: Usage, atReport: Usage, reported: number | null) {
  const livePhoneTime = Math.max(0, estimate.used_core_hours - atReport.used_core_hours);
  const liveUsed = reported === null ? estimate.used_core_hours
    : Math.max(estimate.used_core_hours, reported + livePhoneTime);
  const rate = estimate.running.reduce((sum, phone) => sum + phone.cores, 0);
  return {
    reported_core_hours: reported ?? estimate.used_core_hours,
    phonelink_core_hours: estimate.used_core_hours,
    other_core_hours: reported === null ? 0 : Math.max(0, reported - estimate.used_core_hours),
    hours_left_at_current_rate: rate ? Math.max(0, estimate.allowance_core_hours - liveUsed) / rate : null,
  };
}

/**
 * Calendar-month estimate, in UTC. Open runs accrue up to the injected clock.
 * Included usage is shared across the account; other codespaces are not observable here.
 * https://docs.github.com/en/billing/concepts/product-billing/github-codespaces
 */
export function estimateUsage(runs: Run[], allowance: number, clock: () => number = Date.now) {
  const now = clock();
  const date = new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const used = runs.reduce((sum, run) => {
    const from = Math.max(start, Date.parse(run.started_at));
    const to = Math.min(now, run.stopped_at === null ? now : Date.parse(run.stopped_at));
    return sum + Math.max(0, to - from) / 3_600_000 * run.cores;
  }, 0);
  const running = runs.filter(run => run.stopped_at === null && Date.parse(run.started_at) <= now)
    .map(run => ({ id: run.phone_id, cores: run.cores }));
  const rate = running.reduce((sum, phone) => sum + phone.cores, 0);
  return {
    allowance_core_hours: allowance, used_core_hours: used, running,
    hours_left_at_current_rate: rate ? Math.max(0, allowance - used) / rate : null,
    month: date.toISOString().slice(0, 7), estimated: true as const,
  };
}

export async function saveAllowance(database: Client, userId: number, allowance: number) {
  await updateSettings(database, userId, { allowance_core_hours: allowance });
}

function monthStart(now: number) {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

export async function readUsage(database: DatabaseQueries, userId: number, clock: () => number = Date.now) {
  const runs = (await database.execute({ sql: `SELECT r.phone_id, r.cores, r.started_at, r.stopped_at FROM runs r
    JOIN phones p ON p.id = r.phone_id WHERE p.user_id = ? AND (r.stopped_at IS NULL OR r.stopped_at >= ?)`, args: [userId, monthStart(clock())] })).rows as unknown as Run[];
  return estimateUsage(runs, (await userSettings(database, userId)).allowance_core_hours, clock);
}
