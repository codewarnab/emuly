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
        await queries.execute("DELETE FROM app_admissions WHERE expires_at <= unixepoch()");
        const existing = (await queries.execute({ sql: "SELECT operation_key FROM app_admissions WHERE user_id = ? AND phone_id = ?", args: [userId, phoneId] })).rows[0];
        if (existing && existing.operation_key !== key) return false;
        if (!existing && Number((await queries.execute({ sql: "SELECT count(*) AS n FROM app_admissions WHERE user_id = ?", args: [userId] })).rows[0].n) >= 2) return false;
        await queries.execute({ sql: `INSERT INTO app_admissions (phone_id, user_id, operation_key, expires_at) VALUES (?, ?, ?, unixepoch() + 1800)
          ON CONFLICT(phone_id) DO UPDATE SET expires_at = excluded.expires_at WHERE operation_key = excluded.operation_key`, args: [phoneId, userId, key] });
        return true;
      });
    },
    async release(userId: number, phoneId: string, key: string) {
      await database.execute({ sql: "DELETE FROM app_admissions WHERE phone_id = ? AND user_id = ? AND operation_key = ?", args: [phoneId, userId, key] });
    },
  };
}
