import { randomUUID } from "node:crypto";
import type { DatabaseQueries } from "./async-database.ts";
import { randomId, sha256 } from "../auth/crypto-core.ts";

/** A deletion request stays open for ten minutes. The agent polls every five seconds. */
export const PHONE_DELETE_TTL_MS = 10 * 60 * 1000;
export const PHONE_DELETE_INTERVAL_MS = 5 * 1000;
export const PHONE_DELETE_STATUSES = ["pending", "approved", "denied", "expired", "done"] as const;
export type PhoneDeleteStatus = (typeof PHONE_DELETE_STATUSES)[number];
export type PhoneDeleteRequest = {
  id: string;
  phoneId: string;
  status: PhoneDeleteStatus;
  createdAt: string;
  expiresAt: string;
};
export type PhoneDeleteClaim = {
  status: PhoneDeleteStatus | "invalid";
  claimed: boolean;
  phoneId?: string;
  agentKeyId?: number | null;
};
export type AgentPhoneDeletion = { id: number; phone_name: string; agent_key_name: string; deleted_at: string };

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function currentStatus(status: string, expiresAt: string, now: number): PhoneDeleteStatus {
  if (status === "done" || status === "denied" || status === "approved" || status === "expired") return status;
  return Date.parse(expiresAt) <= now ? "expired" : "pending";
}

/** The raw token is returned once; only its SHA-256 hash is stored. */
export async function createPhoneDeleteRequest(database: DatabaseQueries,
  input: { userId: number; phoneId: string; agentKeyId?: number | null }, now = Date.now()) {
  const token = randomId();
  const id = `pdr_${randomUUID()}`;
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + PHONE_DELETE_TTL_MS).toISOString();
  // Keep the table small without another job. Finished requests cannot match again.
  await database.execute({ sql: `DELETE FROM phone_delete_requests
    WHERE status IN ('done', 'denied', 'expired') AND expires_at <= ?`,
    args: [new Date(now - 24 * 60 * 60 * 1000).toISOString()] });
  await database.execute({ sql: `INSERT INTO phone_delete_requests
    (id, token_hash, user_id, phone_id, agent_key_id, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    args: [id, sha256(token), input.userId, input.phoneId, input.agentKeyId ?? null, createdAt, expiresAt] });
  return { id, token, expiresAt, expiresIn: PHONE_DELETE_TTL_MS / 1000, interval: PHONE_DELETE_INTERVAL_MS / 1000 };
}

export async function getPhoneDeleteRequest(database: DatabaseQueries, userId: number, phoneId: string,
  requestId: string, now = Date.now()): Promise<PhoneDeleteRequest | null> {
  const row = (await database.execute({ sql: `SELECT id, phone_id, status, created_at, expires_at
    FROM phone_delete_requests WHERE id = ? AND user_id = ? AND phone_id = ?`,
    args: [requestId, userId, phoneId] })).rows[0] as unknown as
    { id: string; phone_id: string; status: string; created_at: string; expires_at: string } | undefined;
  if (!row) return null;
  return { id: row.id, phoneId: row.phone_id, status: currentStatus(row.status, row.expires_at, now),
    createdAt: row.created_at, expiresAt: row.expires_at };
}

/** The approval page knows the token, not the row id. A wrong token returns null. */
export async function getPhoneDeleteRequestByToken(database: DatabaseQueries, rawToken: unknown, userId: number,
  now = Date.now()): Promise<PhoneDeleteRequest | null> {
  if (typeof rawToken !== "string" || !TOKEN_PATTERN.test(rawToken)) return null;
  const row = (await database.execute({ sql: `SELECT id, phone_id, status, created_at, expires_at
    FROM phone_delete_requests WHERE token_hash = ? AND user_id = ?`,
    args: [sha256(rawToken), userId] })).rows[0] as unknown as
    { id: string; phone_id: string; status: string; created_at: string; expires_at: string } | undefined;
  if (!row) return null;
  return { id: row.id, phoneId: row.phone_id, status: currentStatus(row.status, row.expires_at, now),
    createdAt: row.created_at, expiresAt: row.expires_at };
}

/** Atomically spends a pending request exactly once. The caller then performs the deletion. */
export async function claimPhoneDeleteRequest(database: DatabaseQueries, rawToken: unknown, userId: number,
  now = Date.now()): Promise<PhoneDeleteClaim> {
  if (typeof rawToken !== "string" || !TOKEN_PATTERN.test(rawToken)) return { status: "invalid", claimed: false };
  const at = new Date(now).toISOString();
  const hash = sha256(rawToken);
  const changed = await database.execute({ sql: `UPDATE phone_delete_requests SET status = 'approved'
    WHERE token_hash = ? AND user_id = ? AND status = 'pending' AND expires_at > ?`, args: [hash, userId, at] });
  const row = (await database.execute({ sql: `SELECT id, phone_id, agent_key_id, status, expires_at
    FROM phone_delete_requests WHERE token_hash = ? AND user_id = ?`, args: [hash, userId] })).rows[0] as unknown as
    { id: string; phone_id: string; agent_key_id: number | null; status: string; expires_at: string } | undefined;
  if (Number(changed.rowsAffected) === 1 && row) {
    return { status: "approved", claimed: true, phoneId: row.phone_id, agentKeyId: row.agent_key_id };
  }
  if (!row) return { status: "invalid", claimed: false };
  return { status: currentStatus(row.status, row.expires_at, now), claimed: false,
    phoneId: row.phone_id, agentKeyId: row.agent_key_id };
}

/** A failed deletion puts the request back so the user can retry until it expires. */
export async function reopenPhoneDeleteRequest(database: DatabaseQueries, id: string, now = Date.now()) {
  const at = new Date(now).toISOString();
  await database.execute({ sql: `UPDATE phone_delete_requests
    SET status = CASE WHEN expires_at > ? THEN 'pending' ELSE 'expired' END WHERE id = ? AND status = 'approved'`,
    args: [at, id] });
}

export async function completePhoneDeleteRequest(database: DatabaseQueries, id: string) {
  await database.execute({ sql: "UPDATE phone_delete_requests SET status = 'done' WHERE id = ? AND status = 'approved'", args: [id] });
}

/** Also settles a request whose phone was already gone before approval. */
export async function finishPhoneDeleteRequest(database: DatabaseQueries, id: string) {
  await database.execute({ sql: `UPDATE phone_delete_requests SET status = 'done'
    WHERE id = ? AND status IN ('pending', 'approved')`, args: [id] });
}

export async function denyPhoneDeleteRequest(database: DatabaseQueries, rawToken: unknown, userId: number,
  now = Date.now()): Promise<PhoneDeleteStatus | "invalid"> {
  if (typeof rawToken !== "string" || !TOKEN_PATTERN.test(rawToken)) return "invalid";
  const at = new Date(now).toISOString();
  const hash = sha256(rawToken);
  const changed = await database.execute({ sql: `UPDATE phone_delete_requests SET status = 'denied'
    WHERE token_hash = ? AND user_id = ? AND status = 'pending' AND expires_at > ?`, args: [hash, userId, at] });
  if (Number(changed.rowsAffected) === 1) return "denied";
  const request = await getPhoneDeleteRequestByToken(database, rawToken, userId, now);
  return request?.status ?? "invalid";
}

/** Keeps a small audit list even after the phone row is gone. */
export async function recordAgentPhoneDeletion(database: DatabaseQueries,
  input: { userId: number; phoneName: string; agentKeyId?: number | null }, now = Date.now()) {
  if (!input.agentKeyId) return false;
  const key = (await database.execute({ sql: "SELECT name FROM agent_keys WHERE id = ? AND user_id = ?",
    args: [input.agentKeyId, input.userId] })).rows[0] as unknown as { name: string } | undefined;
  if (!key) return false;
  await database.execute({ sql: `INSERT INTO agent_phone_deletions (user_id, phone_name, agent_key_name, deleted_at)
    VALUES (?, ?, ?, ?)`, args: [input.userId, input.phoneName, key.name, new Date(now).toISOString()] });
  return true;
}

export async function listAgentPhoneDeletions(database: DatabaseQueries, userId: number,
  limit = 10): Promise<AgentPhoneDeletion[]> {
  const rows = (await database.execute({ sql: `SELECT id, phone_name, agent_key_name, deleted_at
    FROM agent_phone_deletions WHERE user_id = ? ORDER BY deleted_at DESC, id DESC LIMIT ?`,
    args: [userId, Math.max(1, Math.min(50, limit))] })).rows;
  return rows as unknown as AgentPhoneDeletion[];
}
