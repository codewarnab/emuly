import "server-only";
import type { DatabaseSync } from "node:sqlite";
import { GitHubError } from "../github/github.ts";
import { readUsage, type Usage } from "../data/usage.ts";
import { userSettings } from "../data/settings.ts";
import { emitEvent, type LegacyEventEmitter as EventEmitter } from "../data/legacy-events.ts";
import type { Client } from "@libsql/client";
import { retentionStatus } from "../data/retention.ts";
import { createDiagnostics } from "../diagnostics/diagnostics.ts";

/** One loop owns sync, budget, retention policy and webhook delivery. */
export function createStatePoller({ database, settingsDatabase, sync, autoStop, autoKeep, deliver, emit = event => emitEvent(event, database), clock = Date.now }: {
  database: DatabaseSync; settingsDatabase: Client; sync: (userId: number) => Promise<void>; clock?: () => number;
  autoStop?: (userId: number, phoneId: string) => Promise<unknown>; emit?: EventEmitter;
  autoKeep?: (userId: number, phoneId: string) => Promise<unknown>;
  deliver?: () => Promise<void>;
}) {
  let running = false;
  const retryAt = new Map<number, number>();
  const diagnostics = createDiagnostics(settingsDatabase);

  function notifyLow(userId: number, usage: Usage) {
    const left = Math.max(0, usage.allowance_core_hours - usage.used_core_hours);
    const thresholds = [
      ["20%", left <= usage.allowance_core_hours * 0.2],
      ["10%", left <= usage.allowance_core_hours * 0.1],
      ["30min", usage.hours_left_at_current_rate !== null && usage.hours_left_at_current_rate <= 0.5],
    ] as const;
    for (const [threshold, reached] of thresholds) {
      if (!reached) continue;
      database.exec("BEGIN IMMEDIATE");
      try {
        const notice = database.prepare("INSERT OR IGNORE INTO notices (user_id, kind, period) VALUES (?, ?, ?)")
          .run(userId, `hours.low.${threshold}`, usage.month);
        if (notice.changes) emit({ userId, type: "hours.low", createdAt: new Date(clock()).toISOString(),
          data: { threshold, month: usage.month, estimated: true, hours_left_at_current_rate: usage.hours_left_at_current_rate } });
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    }
  }

  async function protectBudget(userId: number) {
    const usage = await readUsage(settingsDatabase, userId, clock);
    notifyLow(userId, usage);
    if (!autoStop || !(await userSettings(settingsDatabase, userId)).auto_stop_before_empty
      || usage.hours_left_at_current_rate === null || usage.hours_left_at_current_rate > 0.5) return;
    // Continue after an individual failure, but stop immediately on provider rate limits.
    let failure: unknown;
    let stopped = 0;
    try {
      for (const phone of usage.running) {
        // Keep it already owns the start/stop sequence and will stop at Available.
        if (database.prepare("SELECT 1 FROM phone_keeps WHERE phone_id = ?").get(phone.id)) continue;
        // Runs stay open while GitHub stops a phone; do not count those again.
        if (!database.prepare("SELECT 1 FROM phones WHERE id = ? AND state IN ('running', 'booting')").get(phone.id)) continue;
        try { await autoStop(userId, phone.id); stopped++; }
        catch (error) {
          if (error instanceof GitHubError && [403, 429].includes(error.status)) throw error;
          failure = error;
        }
      }
    } finally {
      // One event and one toast for each auto-stop run, not one for each phone.
      if (stopped) {
        const createdAt = new Date(clock()).toISOString();
        const message = `Auto-stop stopped ${stopped} ${stopped === 1 ? "phone" : "phones"} with about 30 minutes of estimated hours left. Your codespaces keep them.`;
        database.prepare("INSERT INTO events (user_id, ts, kind, message) VALUES (?, ?, 'hours.auto_stopped', ?)").run(userId, createdAt, message);
        emit({ userId, type: "hours.auto_stopped", createdAt, data: { reason: "hours_budget", message } });
      }
    }
    if (failure) throw failure;
  }

  async function protectRetention(userId: number) {
    const phones = database.prepare(`SELECT id, codespace_name, machine, state, retention_at, last_stopped_at, retention_min
      FROM phones WHERE user_id = ? AND state = 'stopped'
      AND codespace_name NOT LIKE 'pending:%' AND id NOT IN (SELECT phone_id FROM phone_keeps)`).all(userId) as {
        id: string; codespace_name: string; machine: string; state: string;
        retention_at: string | null; last_stopped_at: string | null; retention_min: number;
      }[];
    let failure: unknown;
    for (const phone of phones) {
      const retention = retentionStatus(phone, clock);
      if (!retention) continue;
      const remaining = Date.parse(retention.expiresAt) - clock();
      // Only the nearest threshold, so a phone first seen under 1 day gets one warning.
      const due = remaining <= 86_400_000 ? [1] : remaining <= 2 * 86_400_000 ? [2] : [];
      for (const days of due) {
        database.exec("BEGIN IMMEDIATE");
        try {
          const notice = database.prepare("INSERT OR IGNORE INTO notices (user_id, kind, period) VALUES (?, ?, ?)")
            .run(userId, `retention.warning.${phone.id}.${days}`, retention.expiresAt);
          if (notice.changes) {
            const createdAt = new Date(clock()).toISOString();
            database.prepare("INSERT INTO events (user_id, phone_id, ts, kind, message) VALUES (?, ?, ?, 'retention.warning', ?)")
              .run(userId, phone.id, createdAt, retention.message);
            emit({ userId, type: "retention.warning", createdAt, data: {
              phone: { id: phone.id, name: phone.codespace_name, state: phone.state, machine: phone.machine },
              days, retention_at: retention.expiresAt,
            } });
          }
          database.exec("COMMIT");
        } catch (error) { database.exec("ROLLBACK"); throw error; }
      }
      if (remaining > 86_400_000 || !autoKeep || !(await userSettings(settingsDatabase, userId)).auto_keep) continue;
      try { await autoKeep(userId, phone.id); }
      catch (error) {
        if (error instanceof GitHubError && [403, 429].includes(error.status)) throw error;
        failure = error;
      }
    }
    if (failure) throw failure;
  }

  return async function tick() {
    if (running) return;
    running = true;
    try {
      const users = database.prepare(`SELECT DISTINCT p.user_id FROM phones p JOIN users u ON u.id = p.user_id
        WHERE u.blocked = 0 AND p.state != 'deleted' AND p.codespace_name NOT LIKE 'pending:%'`).all();
      for (const user of users) {
        const id = Number(user.user_id);
        const saved = Number(database.prepare("SELECT retry_at FROM poller_retries WHERE user_id = ?").get(id)?.retry_at ?? 0);
        if (Math.max(saved, retryAt.get(id) ?? 0) > clock()) continue;
        try {
          await sync(id);
          await protectBudget(id);
          await protectRetention(id);
          retryAt.delete(id);
          database.prepare("DELETE FROM poller_retries WHERE user_id = ?").run(id);
        }
        catch (error) {
          const delay = error instanceof GitHubError && [403, 429].includes(error.status) ? 5 * 60_000 : 60_000;
          retryAt.set(id, clock() + delay);
          database.prepare("INSERT INTO poller_retries VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET retry_at = excluded.retry_at, error_code = excluded.error_code")
            .run(id, clock() + delay, delay === 60000 ? "unknown_failure" : "rate_limited");
          for (const row of database.prepare("SELECT id FROM phones WHERE user_id = ? AND state = 'booting' LIMIT 50").all(id)) {
            await diagnostics.mark(await diagnostics.current(id, String(row.id)), "poll_backoff", {
              outcome: "failed", errorCode: delay === 60000 ? "unknown_failure" : "rate_limited", retryDelayMs: delay });
          }
          // Do not log provider errors: they can contain credentials. Pages report sync failures.
        }
      }
      // Run even for users with no phones or a GitHub rate-limit backoff.
      await deliver?.();
    } finally { running = false; }
  };
}
