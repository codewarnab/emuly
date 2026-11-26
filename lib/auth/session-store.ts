import type { DatabaseQueries } from "../data/async-database.ts";
import { randomId, sha256 } from "./crypto-core.ts";

export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
/** The user columns come from the same read, so a page needs no second trip for the signed-in user. */
export type SessionUser = { login: string; name: string | null; avatarUrl: string | null };
export type Session = { id: string; userId: number; expiresAt: string; user?: SessionUser };

const SESSION_COOKIE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A format check only, with no database read. Each page and route still checks the session itself. */
export function sessionCookieShape(value: string | undefined): value is string {
  return !!value && SESSION_COOKIE_PATTERN.test(value);
}

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
  if (!sessionCookieShape(value)) return null;
  const id = sha256(value);
  const row = (await db.execute({ sql: `SELECT s.expires_at, s.user_id, u.blocked, u.login, u.name, u.avatar_url FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.id = ?`, args: [id] })).rows[0] as unknown as
    { expires_at: string; user_id: number; blocked: number; login: string; name: string | null; avatar_url: string | null } | undefined;
  if (!row) return null;
  if (row.blocked || !(Date.parse(row.expires_at) > Date.now())) {
    await db.execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [id] });
    return null;
  }
  return { id, userId: row.user_id, expiresAt: row.expires_at,
    user: { login: row.login, name: row.name, avatarUrl: row.avatar_url } };
}

export async function deleteSession(db: DatabaseQueries, value: string | undefined) {
  if (value) await db.execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [sha256(value)] });
}
