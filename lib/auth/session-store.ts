import type { DatabaseSync } from "node:sqlite";
import { randomId, sha256 } from "./crypto-core.ts";

export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
export type Session = { id: string; userId: number; expiresAt: string };

/** Returns the raw cookie once. Only its hash is persisted. */
export function insertSession(db: DatabaseSync, userId: number) {
  const value = randomId();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();
  db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(sha256(value), userId, createdAt, expiresAt);
  return { value, expiresAt };
}

export function readSession(db: DatabaseSync, value: string | undefined): Session | null {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const id = sha256(value);
  const row = db.prepare(`SELECT s.expires_at, s.user_id, u.blocked FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(id) as
    { expires_at: string; user_id: number; blocked: number } | undefined;
  if (!row) return null;
  if (row.blocked || !(Date.parse(row.expires_at) > Date.now())) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return null;
  }
  return { id, userId: row.user_id, expiresAt: row.expires_at };
}

export function deleteSession(db: DatabaseSync, value: string | undefined) {
  if (value) db.prepare("DELETE FROM sessions WHERE id = ?").run(sha256(value));
}
