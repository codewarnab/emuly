import type { Client } from "@libsql/client";
import { transaction, type DatabaseQueries } from "./async-database.ts";
import { randomId, sha256 } from "../auth/crypto-core.ts";

/** A one-time setup code lives for one hour. The bearer key it becomes lives for 90 days. */
export const SETUP_CODE_TTL_MS = 60 * 60 * 1000;
export const AGENT_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const SETUP_CODE_PREFIX = "emuly_sc_";
export const AGENT_KEY_PREFIX = "emuly_key_";

const SETUP_CODE_PATTERN = /^emuly_sc_[A-Za-z0-9_-]{43}$/;
const AGENT_KEY_PATTERN = /^emuly_key_[A-Za-z0-9_-]{43}$/;

export class AgentInputError extends Error {}

export type AgentKey = {
  id: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  revoked_at: string | null;
};

export type AgentIdentity = { keyId: number; userId: number; name: string };

/** The raw setup code is returned once. Only its SHA-256 hash is stored. */
export async function createSetupCode(database: DatabaseQueries, userId: number, now = Date.now()) {
  const code = SETUP_CODE_PREFIX + randomId();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + SETUP_CODE_TTL_MS).toISOString();
  // Keep the table small without another job. Expired and used codes can never match again.
  await database.execute({ sql: "DELETE FROM agent_setup_codes WHERE user_id = ? AND (used_at IS NOT NULL OR expires_at <= ?)",
    args: [userId, createdAt] });
  await database.execute({ sql: "INSERT INTO agent_setup_codes (code_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    args: [sha256(code), userId, createdAt, expiresAt] });
  return { code, expiresAt };
}

/** Atomically spends a setup code and creates its key. A second use of the same code returns null. */
export async function exchangeSetupCode(database: Client, rawCode: unknown, rawName: unknown, now = Date.now()) {
  if (typeof rawCode !== "string" || !SETUP_CODE_PATTERN.test(rawCode)) return null;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name || name.length > 100) throw new AgentInputError("Give the agent a name up to 100 characters.");
  const usedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + AGENT_KEY_TTL_MS).toISOString();
  const codeHash = sha256(rawCode);
  return transaction(database, async queries => {
    const spent = await queries.execute({ sql: "UPDATE agent_setup_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
      args: [usedAt, codeHash, usedAt] });
    if (Number(spent.rowsAffected) !== 1) return null;
    const row = (await queries.execute({ sql: "SELECT user_id FROM agent_setup_codes WHERE code_hash = ?", args: [codeHash] })).rows[0] as
      unknown as { user_id: number } | undefined;
    if (!row) return null;
    const key = AGENT_KEY_PREFIX + randomId();
    await queries.execute({ sql: "INSERT INTO agent_keys (user_id, name, key_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      args: [row.user_id, name, sha256(key), usedAt, expiresAt] });
    return { key, expiresAt };
  });
}

/** Hash lookup, not a string scan, so a wrong key does not leak length or prefix timing. */
export async function findAgentKey(database: DatabaseQueries, value: string, now = Date.now()): Promise<AgentIdentity | null> {
  if (!AGENT_KEY_PATTERN.test(value)) return null;
  const at = new Date(now).toISOString();
  const row = (await database.execute({ sql: `SELECT k.id, k.user_id, k.name FROM agent_keys k
    JOIN users u ON u.id = k.user_id
    WHERE k.key_hash = ? AND k.revoked_at IS NULL AND k.expires_at > ? AND u.blocked = 0`,
    args: [sha256(value), at] })).rows[0] as unknown as { id: number; user_id: number; name: string } | undefined;
  if (!row) return null;
  await database.execute({ sql: "UPDATE agent_keys SET last_used_at = ? WHERE id = ?", args: [at, row.id] });
  return { keyId: row.id, userId: row.user_id, name: row.name };
}

export async function listAgentKeys(database: DatabaseQueries, userId: number): Promise<AgentKey[]> {
  const rows = (await database.execute({ sql: `SELECT id, name, created_at, last_used_at, expires_at, revoked_at
    FROM agent_keys WHERE user_id = ? ORDER BY created_at DESC, id DESC`, args: [userId] })).rows;
  return rows as unknown as AgentKey[];
}

export async function revokeAgentKey(database: DatabaseQueries, userId: number, id: number, now = Date.now()) {
  const result = await database.execute({ sql: "UPDATE agent_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    args: [new Date(now).toISOString(), id, userId] });
  return Number(result.rowsAffected) === 1;
}

export async function revokeAllAgentKeys(database: DatabaseQueries, userId: number, now = Date.now()) {
  const result = await database.execute({ sql: "UPDATE agent_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
    args: [new Date(now).toISOString(), userId] });
  return Number(result.rowsAffected);
}
