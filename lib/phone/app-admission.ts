import type { Client } from "@libsql/client";
import { transaction } from "../data/async-database.ts";

export function sharedAppAdmission(database: Client) {
  return {
    async current(userId: number, phoneId: string) {
      const row = (await database.execute({ sql: "SELECT operation_key FROM app_admissions WHERE user_id = ? AND phone_id = ? AND expires_at > unixepoch()", args: [userId, phoneId] })).rows[0];
      return row ? String(row.operation_key) : undefined;
    },
    async claim(userId: number, phoneId: string, key: string) {
      return transaction(database, async queries => {
        // A claim is a lease on a live transfer. Drop expired rows and rows whose phone
        // cannot run an install, so a stopped phone never holds an account slot.
        await queries.execute("DELETE FROM app_admissions WHERE expires_at <= unixepoch() OR phone_id NOT IN (SELECT id FROM phones WHERE state IN ('running', 'booting'))");
        const existing = (await queries.execute({ sql: "SELECT operation_key FROM app_admissions WHERE user_id = ? AND phone_id = ?", args: [userId, phoneId] })).rows[0];
        if (!existing && Number((await queries.execute({ sql: "SELECT count(*) AS n FROM app_admissions WHERE user_id = ?", args: [userId] })).rows[0].n) >= 2) return false;
        // One operation per phone: a new attempt replaces the phone's previous claim, and
        // the runner still rejects a second operation while one is active.
        await queries.execute({ sql: `INSERT INTO app_admissions (phone_id, user_id, operation_key, expires_at) VALUES (?, ?, ?, unixepoch() + 1800)
          ON CONFLICT(phone_id) DO UPDATE SET operation_key = excluded.operation_key, expires_at = excluded.expires_at`, args: [phoneId, userId, key] });
        return true;
      });
    },
    async release(userId: number, phoneId: string, key: string) {
      await database.execute({ sql: "DELETE FROM app_admissions WHERE phone_id = ? AND user_id = ? AND operation_key = ?", args: [phoneId, userId, key] });
    },
  };
}
