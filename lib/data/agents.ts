import { randomInt } from "node:crypto";
import type { Client } from "@libsql/client";
import { transaction, type DatabaseQueries } from "./async-database.ts";
import { randomId, sha256 } from "../auth/crypto-core.ts";

/** A one-time setup code lives for one hour. The bearer key it becomes lives for 90 days. */
export const SETUP_CODE_TTL_MS = 60 * 60 * 1000;
export const AGENT_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
export const DEVICE_POLL_INTERVAL_MS = 5 * 1000;
export const SETUP_CODE_PREFIX = "emuly_sc_";
export const AGENT_KEY_PREFIX = "emuly_key_";
export const DEVICE_CODE_PREFIX = "emuly_dc_";

const SETUP_CODE_PATTERN = /^emuly_sc_[A-Za-z0-9_-]{43}$/;
const AGENT_KEY_PATTERN = /^emuly_key_[A-Za-z0-9_-]{43}$/;
const DEVICE_CODE_PATTERN = /^emuly_dc_[A-Za-z0-9_-]{43}$/;
const USER_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const USER_CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const USER_CODE_DIGITS = "23456789";
const DEVICE_KEY_NAME = "Agent device login";

export class AgentInputError extends Error {}
export class AgentDeviceLimitError extends Error {}

export type AgentKey = {
  id: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  revoked_at: string | null;
};

export type AgentIdentity = { keyId: number; userId: number; name: string };

export type DeviceRequestStatus = "pending" | "approved" | "denied" | "used" | "expired";
export type DeviceRequest = {
  userCode: string;
  status: DeviceRequestStatus;
  createdAt: string;
  expiresAt: string;
};
export type DevicePoll =
  | { status: "pending" | "slow_down" | "denied" | "expired" | "invalid" | "used" }
  | { status: "approved"; key: string; expiresAt: string };

/** Generates the short code a user reads and approves. No 0/O/1/I, so it is easy to type. */
function newUserCode() {
  let letters = "";
  let digits = "";
  for (let i = 0; i < 4; i++) letters += USER_CODE_LETTERS[randomInt(USER_CODE_LETTERS.length)];
  for (let i = 0; i < 4; i++) digits += USER_CODE_DIGITS[randomInt(USER_CODE_DIGITS.length)];
  return `${letters}-${digits}`;
}

/** Accepts `wxyz2345`, `WXYZ-2345` and surrounding spaces. Returns the canonical form. */
export function normalizeUserCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(compact)) return null;
  const code = `${compact.slice(0, 4)}-${compact.slice(4)}`;
  return USER_CODE_PATTERN.test(code) ? code : null;
}

function requestStatus(status: string, expiresAt: string, now: number): DeviceRequestStatus {
  if (status === "used") return "used";
  if (status === "denied") return "denied";
  if (Date.parse(expiresAt) <= now) return "expired";
  return status === "approved" ? "approved" : "pending";
}

async function insertAgentKey(queries: DatabaseQueries, userId: number, name: string, now: number) {
  const key = AGENT_KEY_PREFIX + randomId();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + AGENT_KEY_TTL_MS).toISOString();
  await queries.execute({ sql: "INSERT INTO agent_keys (user_id, name, key_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    args: [userId, name, sha256(key), createdAt, expiresAt] });
  return { key, expiresAt };
}

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
  const codeHash = sha256(rawCode);
  return transaction(database, async queries => {
    const spent = await queries.execute({ sql: "UPDATE agent_setup_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
      args: [usedAt, codeHash, usedAt] });
    if (Number(spent.rowsAffected) !== 1) return null;
    const row = (await queries.execute({ sql: "SELECT user_id FROM agent_setup_codes WHERE code_hash = ?", args: [codeHash] })).rows[0] as
      unknown as { user_id: number } | undefined;
    if (!row) return null;
    return insertAgentKey(queries, row.user_id, name, now);
  });
}

/** Starts an RFC 8628 device login. Only the SHA-256 hash of the long device code is stored. */
export async function createDeviceCode(database: DatabaseQueries, now = Date.now()) {
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + DEVICE_CODE_TTL_MS).toISOString();
  // Keep expired rows for a day so `/link` can still explain that a code expired.
  await database.execute({ sql: "DELETE FROM agent_device_codes WHERE expires_at <= ?",
    args: [new Date(now - 24 * 60 * 60 * 1000).toISOString()] });
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = newUserCode();
    const deviceCode = DEVICE_CODE_PREFIX + randomId();
    const pending = (await database.execute({ sql: "SELECT 1 FROM agent_device_codes WHERE user_code = ? AND status = 'pending'",
      args: [userCode] })).rows.length;
    if (pending) continue;
    try {
      const inserted = await database.execute({ sql: `INSERT INTO agent_device_codes
        (device_code_hash, user_code, status, user_id, created_at, expires_at, last_polled_at)
        SELECT ?, ?, 'pending', NULL, ?, ?, NULL
        WHERE (SELECT count(*) FROM agent_device_codes WHERE expires_at > ?) < 500`,
        args: [sha256(deviceCode), userCode, createdAt, expiresAt, createdAt] });
      if (!inserted.rowsAffected) throw new AgentDeviceLimitError();
      return {
        deviceCode,
        userCode,
        expiresAt,
        expiresIn: DEVICE_CODE_TTL_MS / 1000,
        interval: DEVICE_POLL_INTERVAL_MS / 1000,
      };
    } catch (error) {
      if (error instanceof AgentDeviceLimitError || attempt === 4) throw error;
    }
  }
  throw new Error("Could not create a device code.");
}

/** Reads a request for the `/link` page. A wrong or unknown code returns null. */
export async function getDeviceRequest(database: DatabaseQueries, rawUserCode: unknown,
  now = Date.now()): Promise<DeviceRequest | null> {
  const userCode = normalizeUserCode(rawUserCode);
  if (!userCode) return null;
  const row = (await database.execute({ sql: `SELECT user_code, status, created_at, expires_at
    FROM agent_device_codes WHERE user_code = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    args: [userCode] })).rows[0] as unknown as
    { user_code: string; status: string; created_at: string; expires_at: string } | undefined;
  if (!row) return null;
  return { userCode: row.user_code, status: requestStatus(row.status, row.expires_at, now),
    createdAt: row.created_at, expiresAt: row.expires_at };
}

/** A browser session approves a pending code. The same code cannot approve twice. */
export async function approveDeviceCode(database: DatabaseQueries, rawUserCode: unknown, userId: number,
  now = Date.now()): Promise<DeviceRequestStatus | "invalid"> {
  const userCode = normalizeUserCode(rawUserCode);
  if (!userCode) return "invalid";
  const at = new Date(now).toISOString();
  const changed = await database.execute({ sql: `UPDATE agent_device_codes SET status = 'approved', user_id = ?
    WHERE user_code = ? AND status = 'pending' AND expires_at > ?`, args: [userId, userCode, at] });
  if (Number(changed.rowsAffected) === 1) return "approved";
  return (await getDeviceRequest(database, userCode, now))?.status ?? "invalid";
}

/** A browser session can deny a pending code; the agent then receives `access_denied`. */
export async function denyDeviceCode(database: DatabaseQueries, rawUserCode: unknown,
  now = Date.now()): Promise<DeviceRequestStatus | "invalid"> {
  const userCode = normalizeUserCode(rawUserCode);
  if (!userCode) return "invalid";
  const at = new Date(now).toISOString();
  const changed = await database.execute({ sql: `UPDATE agent_device_codes SET status = 'denied'
    WHERE user_code = ? AND status = 'pending' AND expires_at > ?`, args: [userCode, at] });
  if (Number(changed.rowsAffected) === 1) return "denied";
  return (await getDeviceRequest(database, userCode, now))?.status ?? "invalid";
}

/** Polls a device login. Approval is spent atomically, so the key is minted exactly once. */
export async function pollDeviceCode(database: Client, rawDeviceCode: unknown,
  now = Date.now()): Promise<DevicePoll> {
  if (typeof rawDeviceCode !== "string" || !DEVICE_CODE_PATTERN.test(rawDeviceCode)) return { status: "invalid" };
  const at = new Date(now).toISOString();
  const hash = sha256(rawDeviceCode);
  return transaction(database, async queries => {
    const row = (await queries.execute({ sql: `SELECT status, user_id, expires_at, last_polled_at
      FROM agent_device_codes WHERE device_code_hash = ?`, args: [hash] })).rows[0] as unknown as
      { status: string; user_id: number | null; expires_at: string; last_polled_at: string | null } | undefined;
    if (!row) return { status: "invalid" };
    if (row.status === "used") return { status: "used" };
    if (row.status === "denied") return { status: "denied" };
    if (Date.parse(row.expires_at) <= now) return { status: "expired" };
    if (row.status === "approved") {
      if (row.user_id === null) return { status: "invalid" };
      const spent = await queries.execute({ sql: `UPDATE agent_device_codes SET status = 'used', last_polled_at = ?
        WHERE device_code_hash = ? AND status = 'approved' AND expires_at > ?`, args: [at, hash, at] });
      if (Number(spent.rowsAffected) !== 1) return { status: "used" };
      return { status: "approved", ...(await insertAgentKey(queries, row.user_id, DEVICE_KEY_NAME, now)) };
    }
    if (row.last_polled_at && now - Date.parse(row.last_polled_at) < DEVICE_POLL_INTERVAL_MS) {
      return { status: "slow_down" };
    }
    await queries.execute({ sql: "UPDATE agent_device_codes SET last_polled_at = ? WHERE device_code_hash = ? AND status = 'pending'",
      args: [at, hash] });
    return { status: "pending" };
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
