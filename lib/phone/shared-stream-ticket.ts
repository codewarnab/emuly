import { randomBytes, createHash } from "node:crypto";
import type { DatabaseQueries } from "../data/async-database.ts";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export async function issueSharedStreamTicket(database: DatabaseQueries, ticket: {
  userId: number; phoneId: string; sessionId: string; origin: string; cookie: string;
}) {
  await database.execute("DELETE FROM stream_tickets WHERE expires_at <= unixepoch()");
  const value = randomBytes(32).toString("base64url");
  await database.execute({ sql: `INSERT INTO stream_tickets (hash, user_id, phone_id, session_id, origin, cookie_hash, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, unixepoch() + 60)`, args: [hash(value), ticket.userId, ticket.phoneId, ticket.sessionId, ticket.origin, hash(ticket.cookie)] });
  return value;
}
export async function takeSharedStreamTicket(database: DatabaseQueries, value: string, phoneId: string, origin: string, cookie: string) {
  if (!/^[\w-]{43}$/.test(value)) return;
  const row = (await database.execute({ sql: `DELETE FROM stream_tickets WHERE hash = ? AND phone_id = ? AND origin = ?
    AND cookie_hash = ? AND expires_at > unixepoch() RETURNING user_id, session_id`,
    args: [hash(value), phoneId, origin, hash(cookie)] })).rows[0];
  return row ? { userId: Number(row.user_id), sessionId: String(row.session_id) } : undefined;
}
