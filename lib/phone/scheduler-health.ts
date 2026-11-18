import type { DatabaseQueries } from "../data/async-database.ts";

/** The VM cron calls /api/cron every 60 s. Older than this, the scheduler is late. */
export const SCHEDULER_LATE_MS = 5 * 60_000;

/** Record the start and the result of one scheduler run, then return the work's result. */
export async function recordSchedulerRun<T>(database: DatabaseQueries, name: string, work: () => Promise<T>, clock = Date.now) {
  await database.execute({ sql: `INSERT INTO scheduler_runs (name, started_at) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET started_at = excluded.started_at`, args: [name, clock()] });
  let ok = false;
  try { const result = await work(); ok = true; return result; }
  finally {
    await database.execute({ sql: "UPDATE scheduler_runs SET finished_at = ?, ok = ? WHERE name = ?", args: [clock(), ok ? 1 : 0, name] });
  }
}

export type SchedulerHealth = { name: string; late: boolean; started_at: number | null; finished_at: number | null; ok: boolean };

/** Late when no run started within SCHEDULER_LATE_MS, or when there was never a run. */
export async function schedulerHealth(database: DatabaseQueries, name: string, clock = Date.now): Promise<SchedulerHealth> {
  const row = (await database.execute({ sql: "SELECT started_at, finished_at, ok FROM scheduler_runs WHERE name = ?", args: [name] })).rows[0];
  const started = row ? Number(row.started_at) : null;
  return { name, late: started === null || clock() - started > SCHEDULER_LATE_MS, started_at: started,
    finished_at: row?.finished_at == null ? null : Number(row.finished_at), ok: Boolean(row && Number(row.ok)) };
}
