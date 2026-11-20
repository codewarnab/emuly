import type { Client } from "@libsql/client";
import { transaction } from "../data/async-database.ts";
import { emitEvent, type EventEmitter } from "../data/events.ts";

/** Extra time for a ready phone whose Android input time cannot be read. */
export const ANDROID_UNKNOWN_GRACE_MS = 15 * 60_000;
/** phone.idle_warning goes out this long before an idle stop. */
export const IDLE_WARNING_MS = 5 * 60_000;

type IdleColumns = { state: string; android_state?: string | null; idle_timeout_min: number; keeping?: unknown;
  last_activity_at?: string | null; android_started_at?: string | null; last_started_at?: string | null };

/** When Emuly's idle rule stops this phone if nobody uses it, or null when no idle stop applies. */
export function idleStopAt(phone: IdleColumns): string | null {
  if (phone.state !== "running" || phone.android_state === "booting" || Number(phone.keeping ?? 0)) return null;
  const since = Date.parse(phone.last_activity_at ?? phone.android_started_at ?? phone.last_started_at ?? "");
  return Number.isFinite(since) ? new Date(since + Number(phone.idle_timeout_min) * 60_000).toISOString() : null;
}

type IdlePhone = { userId: number; id: string; codespaceName: string };

/**
 * Stops each running phone that had no human or agent action for its idle time.
 * This is the only timer that enforces the user's idle_timeout_min: GitHub's own timer gets
 * PROVIDER_IDLE_MIN (240 min) and is only a safety net, because it does not count API calls.
 *
 * The idle clock starts at phones.last_activity_at (browser input and agent calls). Before the
 * first action it starts at Android's start, then at the codespace start.
 * For a ready phone, Android's own last input (scrcpy clicks) must also be old.
 * If a ready phone's Android cannot be read, the phone gets ANDROID_UNKNOWN_GRACE_MS more, so a short
 * runner fault does not stop a phone that someone uses through scrcpy.
 * A phone that is still booting is left to the boot code.
 * IDLE_WARNING_MS before the stop, the phone gets one phone.idle_warning event for each idle period.
 */
export async function stopIdlePhones({ database, androidIdleMs, stop, clock = Date.now, emit = (event, queries = database) => emitEvent(event, queries) }: {
  database: Client;
  emit?: EventEmitter;
  androidIdleMs: (phone: IdlePhone) => Promise<number | null>;
  stop: (userId: number, id: string) => Promise<unknown>;
  clock?: () => number;
}) {
  const rows = (await database.execute(`SELECT p.user_id, p.id, p.codespace_name, p.idle_timeout_min, p.android_state,
      COALESCE(p.last_activity_at, p.android_started_at, p.last_started_at) AS since
    FROM phones p WHERE p.state = 'running' AND p.android_state != 'booting'
    AND COALESCE(p.last_activity_at, p.android_started_at, p.last_started_at) IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM phone_keeps k WHERE k.phone_id = p.id)`)).rows;
  let stopped = 0;
  async function warn(phone: IdlePhone, start: number, stopAt: number) {
    await transaction(database, async queries => {
      // One warning for each idle period: the period is the time the idle clock started.
      const notice = await queries.execute({ sql: "INSERT OR IGNORE INTO notices (user_id, kind, period) VALUES (?, ?, ?)",
        args: [phone.userId, `idle.warning.${phone.id}`, new Date(start).toISOString()] });
      if (!notice.rowsAffected) return;
      const meta = (await queries.execute({ sql: "SELECT state, machine FROM phones WHERE id = ?", args: [phone.id] })).rows[0];
      const minutes = Math.max(1, Math.round((stopAt - clock()) / 60_000));
      await emit({ userId: phone.userId, type: "phone.idle_warning", createdAt: new Date(clock()).toISOString(), data: {
        phone: { id: phone.id, name: phone.codespaceName, state: String(meta?.state ?? "running"), machine: String(meta?.machine ?? "") },
        idle_stop_at: new Date(stopAt).toISOString(),
        message: `Emuly stops this phone in about ${minutes} min because nobody used it. Use the phone to keep it running.` } }, queries);
    });
  }
  for (const row of rows) {
    const phone = { userId: Number(row.user_id), id: String(row.id), codespaceName: String(row.codespace_name) };
    const limit = Number(row.idle_timeout_min) * 60_000;
    const now = clock();
    const since = Date.parse(String(row.since));
    if (!Number.isFinite(since) || now - since < limit - IDLE_WARNING_MS) continue;
    const android = row.android_state === "ready" ? await androidIdleMs(phone).catch(() => null) : null;
    let idle = now - since;
    let start = since;
    if (android !== null && now - android > since + 60_000) {
      // A scrcpy click: move the stored time up, so the next run does not ask Android again too soon.
      // Only a change over 60 s counts, so small read jitter keeps one idle period (and one warning).
      start = now - android;
      idle = android;
      await database.execute({ sql: "UPDATE phones SET last_activity_at = ? WHERE id = ? AND user_id = ?",
        args: [new Date(start).toISOString(), phone.id, phone.userId] });
    }
    if (idle < limit - IDLE_WARNING_MS) continue;
    if (idle < limit) { await warn(phone, start, start + limit).catch(() => {}); continue; }
    if (android === null && row.android_state === "ready" && idle < limit + ANDROID_UNKNOWN_GRACE_MS) continue;
    try { await stop(phone.userId, phone.id); stopped++; }
    catch (error) { console.error(`[idle-stop] ${phone.id}: stop failed`, error instanceof Error ? error.name : "unknown"); }
  }
  return stopped;
}
