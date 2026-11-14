import type { Client } from "@libsql/client";

export type ActivityOwner = { userId: number; id: string };

/** One write per phone each 30 s at most, so clicks and agent calls cost few database writes. */
export const ACTIVITY_WRITE_MS = 30_000;

/**
 * Records the last human or agent action on a phone in phones.last_activity_at.
 * Writes are fire-and-forget: a failed write must never break a tap or an adb call.
 */
export function createActivity(database: Client, clock: () => number = Date.now) {
  const written = new Map<string, number>();
  return {
    mark(phone: ActivityOwner) {
      const now = clock();
      const key = `${phone.userId}:${phone.id}`;
      if (now - (written.get(key) ?? -Infinity) < ACTIVITY_WRITE_MS) return;
      written.set(key, now);
      void database.execute({ sql: "UPDATE phones SET last_activity_at = ? WHERE user_id = ? AND id = ?",
        args: [new Date(now).toISOString(), phone.userId, phone.id] }).catch(() => { written.delete(key); });
    },
    /** True while the phone had an action within its idle time. Unknown phones count as active. */
    async recent(phone: ActivityOwner) {
      const row = (await database.execute({ sql: "SELECT last_activity_at, idle_timeout_min FROM phones WHERE user_id = ? AND id = ?",
        args: [phone.userId, phone.id] })).rows[0];
      if (!row || row.last_activity_at === null) return true;
      return clock() - Date.parse(String(row.last_activity_at)) < Number(row.idle_timeout_min) * 60_000;
    },
  };
}

/**
 * Reads Android's own last input time from `dumpsys power`. Every touch and key reaches Android,
 * so this also sees scrcpy clicks, which never pass through Emuly. Returns ms since that input,
 * or null when the output has no usable value.
 */
export function androidIdleMs(output: string): number | null {
  const uptime = /^\s*(\d+(?:\.\d+)?)\s/m.exec(output);
  const last = /mLastUserActivityTime=(\d+)/.exec(output);
  if (!uptime || !last) return null;
  const idle = Math.round(Number(uptime[1]) * 1000) - Number(last[1]);
  return idle >= 0 ? idle : null;
}

/** The adb shell command whose output androidIdleMs reads: uptime first, then the power dump line. */
export const ANDROID_IDLE_COMMAND = ["shell", "cat /proc/uptime; dumpsys power | grep mLastUserActivityTime="];
