import type { Client } from "@libsql/client";
import { asyncDb } from "../data/async-db.ts";
import type { Session } from "./session-store.ts";
import { bearerValue, authenticateAgent } from "./agent.ts";

export type AuthKind = "session" | "agent";

export type User = {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  initials: string;
  authKind: AuthKind;
  /** Present only for agent requests, so the console can show which key was used later. */
  agentKeyId?: number;
};

type UserRow = { id: number; login: string; name: string | null; avatar_url: string | null };

/** Authenticate an agent bearer key first, then fall back to the browser session cookie.
    A bearer key that is expired or revoked does not fall back, so the agent sees 401 and can repair. */
export async function resolveUser({ authorization, session, database = asyncDb(), now = Date.now() }: {
  authorization: string | null;
  session: Session | null;
  database?: Client;
  now?: number;
}): Promise<User | null> {
  const bearer = bearerValue(authorization);
  if (bearer) {
    const agent = await authenticateAgent(authorization, database, now);
    if (!agent) return null;
    return loadUser(database, agent.userId, "agent", agent.keyId);
  }
  return session ? loadUser(database, session.userId, "session") : null;
}

async function loadUser(database: Client, userId: number, authKind: AuthKind, agentKeyId?: number): Promise<User | null> {
  const row = (await database.execute({ sql: "SELECT id, login, name, avatar_url FROM users WHERE id = ? AND blocked = 0",
    args: [userId] })).rows[0] as unknown as UserRow | undefined;
  if (!row) return null;
  const initials = (row.name?.trim().split(/\s+/).map(part => Array.from(part)[0]).slice(0, 2).join("")
    || row.login.slice(0, 2)).toUpperCase();
  return { id: row.id, login: row.login, name: row.name, avatarUrl: row.avatar_url, initials, authKind,
    ...(agentKeyId === undefined ? {} : { agentKeyId }) };
}
