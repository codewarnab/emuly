import type { DatabaseQueries } from "../data/async-database.ts";
import type { Usage } from "../data/usage.ts";

export function hoursWarning(usage: Usage, automatic: boolean) {
  if (usage.hours_left_at_current_rate === null || usage.hours_left_at_current_rate > 0.5) return null;
  return automatic
    ? "About 30 minutes of estimated hours left. Auto-stop will stop your phones on the next tick. Stopping keeps your phones."
    : "About 30 minutes of hours left. Stopping keeps your phones.";
}

export async function unreadAutoStops(database: DatabaseQueries, userId: number) {
  return (await database.execute({ sql: `SELECT e.id, e.message FROM events e WHERE e.user_id = ? AND e.kind = 'hours.auto_stopped'
    AND NOT EXISTS (SELECT 1 FROM notices n WHERE n.user_id = e.user_id
      AND n.kind = 'hours.auto_stopped.seen' AND n.period = CAST(e.id AS TEXT)) ORDER BY e.id LIMIT 50`, args: [userId] })).rows as unknown as { id: number; message: string }[];
}

export async function acknowledgeAutoStops(database: DatabaseQueries, userId: number, ids: number[]) {
  for (const id of ids) {
    await database.execute({ sql: `INSERT OR IGNORE INTO notices (user_id, kind, period)
      SELECT user_id, 'hours.auto_stopped.seen', CAST(id AS TEXT) FROM events
      WHERE id = ? AND user_id = ? AND kind = 'hours.auto_stopped'`, args: [id, userId] });
  }
}
