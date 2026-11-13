import "server-only";
import { ipAddress } from "@vercel/functions";
import { transaction } from "../data/async-database.ts";
import { sha256 } from "./crypto-core.ts";
import type { Client } from "@libsql/client";
import { asyncDb } from "../data/async-db.ts";
import { findAgentKey } from "../data/agents.ts";

/** Extracts the token from `Authorization: Bearer emuly_key_...`. Other schemes are ignored. */
export function bearerValue(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

/** An expired, revoked or unknown key returns null, which every `/v1` route treats as signed out. */
export async function authenticateAgent(authorization: string | null, database: Client = asyncDb(), now = Date.now()) {
  const value = bearerValue(authorization);
  return value ? findAgentKey(database, value, now) : null;
}

/** Vercel overwrites x-real-ip; local proxies append their client to x-forwarded-for. */
export function clientIp(request: Request): string {
  const vercelIp = process.env.VERCEL === "1" ? ipAddress(request)?.trim() : undefined;
  return vercelIp || request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
}

async function allowAttempts(bucket: string, ip: string, database: Client, now: number) {
  const key = sha256(ip);
  return transaction(database, async queries => {
    await queries.execute({ sql: "DELETE FROM rate_limit_hits WHERE ts <= ?", args: [now - 60_000] });
    const hit = await queries.execute({ sql: `INSERT INTO rate_limit_hits (bucket, key, ts)
      SELECT ?, ?, ? WHERE (SELECT count(*) FROM rate_limit_hits WHERE bucket = ? AND key = ?) < 10`,
      args: [bucket, key, now, bucket, key] });
    return hit.rowsAffected === 1;
  });
}

export function allowAgentExchange(ip: string, database: Client = asyncDb(), now = Date.now()) {
  return allowAttempts("agent_exchange", ip, database, now);
}

export function allowAgentDeviceStart(ip: string, database: Client = asyncDb(), now = Date.now()) {
  return allowAttempts("agent_device", ip, database, now);
}

const SAFE_KEY = /^emuly_key_[A-Za-z0-9_-]+$/;

/** Ready-to-run commands that keep the key in the Windows user variable EMULY_KEY,
    so the agent never handles a file path. The key is checked before it is quoted. */
export function agentKeyCommands(key: string) {
  if (!SAFE_KEY.test(key)) throw new Error("Unexpected agent key format.");
  return {
    save: `setx EMULY_KEY "${key}"`,
    read: "[Environment]::GetEnvironmentVariable('EMULY_KEY','User')",
    clear: 'setx EMULY_KEY ""',
  };
}
