import type { DatabaseQueries } from "../data/async-database.ts";
import { randomId, sha256 } from "./crypto-core.ts";

export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
export type Session = { id: string; userId: number; expiresAt: string };

/** Returns the raw cookie once. Only its hash is persisted. */
export async function insertSession(db: DatabaseQueries, userId: number) {
  const value = randomId();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();
  await db.execute({ sql: "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    args: [sha256(value), userId, createdAt, expiresAt] });
  return { value, expiresAt };
}

export async function readSession(db: DatabaseQueries, value: string | undefined): Promise<Session | null> {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const id = sha256(value);
  const row = (await db.execute({ sql: `SELECT s.expires_at, s.user_id, u.blocked FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.id = ?`, args: [id] })).rows[0] as unknown as
    { expires_at: string; user_id: number; blocked: number } | undefined;
  if (!row) return null;
  if (row.blocked || !(Date.parse(row.expires_at) > Date.now())) {
    await db.execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [id] });
    return null;
  }
  return { id, userId: row.user_id, expiresAt: row.expires_at };
}

export async function deleteSession(db: DatabaseQueries, value: string | undefined) {
  if (value) await db.execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [sha256(value)] });
}
