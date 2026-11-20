import type { Client } from "@libsql/client";

/** Extra time for a ready phone whose Android input time cannot be read. */
export const ANDROID_UNKNOWN_GRACE_MS = 15 * 60_000;

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
 */
export async function stopIdlePhones({ database, androidIdleMs, stop, clock = Date.now }: {
  database: Client;
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
  for (const row of rows) {
    const phone = { userId: Number(row.user_id), id: String(row.id), codespaceName: String(row.codespace_name) };
    const limit = Number(row.idle_timeout_min) * 60_000;
    const now = clock();
    const since = Date.parse(String(row.since));
    if (!Number.isFinite(since) || now - since < limit) continue;
    const android = row.android_state === "ready" ? await androidIdleMs(phone).catch(() => null) : null;
    if (android !== null && android < limit) {
      // A scrcpy click: move the stored time up, so the next run does not ask Android again too soon.
      await database.execute({ sql: "UPDATE phones SET last_activity_at = ? WHERE id = ? AND user_id = ?",
        args: [new Date(now - android).toISOString(), phone.id, phone.userId] });
      continue;
    }
    if (android === null && row.android_state === "ready" && now - since < limit + ANDROID_UNKNOWN_GRACE_MS) continue;
    try { await stop(phone.userId, phone.id); stopped++; }
    catch (error) { console.error(`[idle-stop] ${phone.id}: stop failed`, error instanceof Error ? error.name : "unknown"); }
  }
  return stopped;
}
