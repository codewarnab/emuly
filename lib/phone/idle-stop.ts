import type { Client } from "@libsql/client";

type IdlePhone = { userId: number; id: string; codespaceName: string };

/**
 * Stops each ready phone that had no human or agent action for its idle time.
 * Two sources must both be old: phones.last_activity_at (browser input and agent calls) and
 * Android's own last input (which also sees scrcpy clicks). If Android cannot be read, the
 * phone keeps running and GitHub's own idle timer stays the safety net.
 */
export async function stopIdlePhones({ database, androidIdleMs, stop, clock = Date.now }: {
  database: Client;
  androidIdleMs: (phone: IdlePhone) => Promise<number | null>;
  stop: (userId: number, id: string) => Promise<unknown>;
  clock?: () => number;
}) {
  const rows = (await database.execute(`SELECT p.user_id, p.id, p.codespace_name, p.idle_timeout_min, p.last_activity_at
    FROM phones p WHERE p.state = 'running' AND p.android_state = 'ready' AND p.last_activity_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM phone_keeps k WHERE k.phone_id = p.id)`)).rows;
  let stopped = 0;
  for (const row of rows) {
    const phone = { userId: Number(row.user_id), id: String(row.id), codespaceName: String(row.codespace_name) };
    const limit = Number(row.idle_timeout_min) * 60_000;
    const now = clock();
    if (now - Date.parse(String(row.last_activity_at)) < limit) continue;
    const android = await androidIdleMs(phone).catch(() => null);
    if (android === null) continue;
    if (android < limit) {
      // A scrcpy click: move the stored time up, so the next run does not ask Android again too soon.
      await database.execute({ sql: "UPDATE phones SET last_activity_at = ? WHERE id = ? AND user_id = ?",
        args: [new Date(now - android).toISOString(), phone.id, phone.userId] });
      continue;
    }
    try { await stop(phone.userId, phone.id); stopped++; }
    catch (error) { console.error(`[idle-stop] ${phone.id}: stop failed`, error instanceof Error ? error.name : "unknown"); }
  }
  return stopped;
}
