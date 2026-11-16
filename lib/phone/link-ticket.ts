import { randomBytes, createHash } from "node:crypto";
import type { DatabaseQueries } from "../data/async-database.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * A one-use ticket for a Route B relay. `emuly link` gets it with the Emuly key and puts it in
 * the websocket URL, so the key itself never goes into a URL. It names the ports it may relay.
 */
export async function issueLinkTicket(database: DatabaseQueries, ticket: { userId: number; phoneId: string; ports: number[] }) {
  await database.execute("DELETE FROM link_tickets WHERE expires_at <= unixepoch()");
  const value = randomBytes(32).toString("base64url");
  await database.execute({ sql: `INSERT INTO link_tickets (hash, user_id, phone_id, ports, expires_at)
    VALUES (?, ?, ?, ?, unixepoch() + 60)`, args: [hash(value), ticket.userId, ticket.phoneId, ticket.ports.join(",")] });
  return value;
}

export async function takeLinkTicket(database: DatabaseQueries, value: string, phoneId: string) {
  if (!/^[\w-]{43}$/.test(value)) return;
  const row = (await database.execute({ sql: `DELETE FROM link_tickets WHERE hash = ? AND phone_id = ?
    AND expires_at > unixepoch() RETURNING user_id, ports`, args: [hash(value), phoneId] })).rows[0];
  if (!row) return;
  return { userId: Number(row.user_id), ports: String(row.ports).split(",").map(Number) };
}
