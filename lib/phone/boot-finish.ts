import type { Client } from "@libsql/client";
import { transaction } from "../data/async-database.ts";

export const BOOT_FAILED_DETAIL = "Android boot failed. Retry boot.";

export type BootOutcome = {
  userId: number;
  id: string;
  /** The boot attempt: phones.android_started_at written when this boot started. */
  attempt: string;
  booted: boolean;
  /** Start of the first try, for "took N s"; a retry that joins a running boot keeps it. */
  firstStarted?: string;
};

/**
 * The one place that ends a boot. The boot call (phone-mutations.ts) and a runner push event
 * (runner-events.ts) both use it, so the state, the step event and the idle clock never drift.
 *
 * It changes the row only while the phone runs and is still `booting` for this attempt.
 * Returns "applied" when this call ended the boot, "already" when the same result is already
 * stored for this attempt (a duplicate, or the other path was first), else "stale".
 */
export async function finishBoot(database: Client, outcome: BootOutcome, now: number,
  redact: (message: string) => string = message => message): Promise<"applied" | "already" | "stale"> {
  const { userId, id, attempt, booted } = outcome;
  const state = booted ? "ready" : "failed";
  return transaction(database, async queries => {
    // Android ready starts the idle clock, so a new phone does not count as idle at once.
    const result = await queries.execute({ sql: `UPDATE phones SET android_state = ?, android_error = ?,
      last_activity_at = CASE WHEN ? THEN ? ELSE last_activity_at END,
      android_ready_at = CASE WHEN ? THEN ? ELSE android_ready_at END
      WHERE user_id = ? AND id = ? AND state = 'running' AND android_state = 'booting' AND android_started_at = ?`,
    args: [state, booted ? null : BOOT_FAILED_DETAIL, booted ? 1 : 0, new Date(now).toISOString(),
      booted ? 1 : 0, new Date(now).toISOString(), userId, id, attempt] });
    if (result.rowsAffected) {
      const took = Math.round((now - Date.parse(outcome.firstStarted ?? attempt)) / 1000);
      const message = booted ? `Android ready (took ${took} s)` : `Android boot failed: ${BOOT_FAILED_DETAIL}`;
      await queries.execute({ sql: "INSERT INTO events (user_id, phone_id, ts, kind, message) VALUES (?, ?, ?, ?, ?)",
        args: [userId, id, new Date(now).toISOString(), booted ? "step" : "error", redact(message)] });
      return "applied";
    }
    const row = (await queries.execute({ sql: "SELECT 1 FROM phones WHERE user_id = ? AND id = ? AND android_state = ? AND android_started_at = ?",
      args: [userId, id, state, attempt] })).rows[0];
    return row ? "already" : "stale";
  });
}
