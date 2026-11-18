import type { DatabaseQueries } from "../data/async-database.ts";
import { CoordinationBusyError } from "../data/coordination.ts";
import { syncError, type SyncError } from "../shared/sync-error.ts";

/** A page load syncs with GitHub at most this often per user. The VM cron also syncs every 60 s. */
export const SYNC_INTERVAL_MS = 15_000;

/** When the next sync may run. A busy GitHub sets its own wait; everything else uses the interval. */
export function nextSyncAt(now: number, error: SyncError | null, intervalMs = SYNC_INTERVAL_MS) {
  return now + Math.max(intervalMs, error?.kind === "busy" ? (error.retryAfter ?? 60) * 1000 : 0);
}

/**
 * One gate for every GitHub state sync, shared by all server instances through the database.
 * "due" runs only when the interval has passed and never throws: pages call it after the response.
 * "always" runs at once and rethrows, so the scheduler keeps its own retry handling.
 */
export function createSyncGate({ database, sync, clock = Date.now, intervalMs = SYNC_INTERVAL_MS }: {
  database: DatabaseQueries; sync: (userId: number) => Promise<void>; clock?: () => number; intervalMs?: number;
}) {
  async function record(userId: number, error: SyncError | null) {
    const now = clock();
    await database.execute({ sql: "UPDATE user_syncs SET next_at = ?, synced_at = ?, error = ? WHERE user_id = ?",
      args: [nextSyncAt(now, error, intervalMs), now, error && JSON.stringify(error), userId] });
  }

  async function run(userId: number, mode: "due" | "always") {
    const now = clock();
    // The claim is one statement, so two instances cannot both win the same interval.
    const claimed = await database.execute({ sql: `INSERT INTO user_syncs (user_id, next_at) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET next_at = excluded.next_at WHERE ? OR user_syncs.next_at <= ?`,
      args: [userId, now + intervalMs, mode === "always" ? 1 : 0, now] });
    if (!claimed.rowsAffected) return "skipped" as const;
    try {
      await sync(userId);
      await record(userId, null);
      return "synced" as const;
    } catch (error) {
      // Another request holds the phone lock and updates the same state now. Keep the stored result.
      // The scheduler still gets the error and backs off as before.
      if (error instanceof CoordinationBusyError) {
        if (mode === "always") throw error;
        return "synced" as const;
      }
      try { await record(userId, syncError(error)); } catch (recordError) { if (mode === "always") throw recordError; }
      if (mode === "always") throw error;
      return "failed" as const;
    }
  }

  return { run, lastError: (userId: number) => readSyncError(database, userId) };
}

/** The result of the last finished sync: shown on both pages and watched by the /app/events stream. */
export async function readSyncError(database: DatabaseQueries, userId: number): Promise<SyncError | null> {
  const raw = (await database.execute({ sql: "SELECT error FROM user_syncs WHERE user_id = ?", args: [userId] })).rows[0]?.error;
  return typeof raw === "string" ? JSON.parse(raw) as SyncError : null;
}
