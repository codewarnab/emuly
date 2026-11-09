import "server-only";
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

const exchangeWindowMs = 60_000;
const exchangeLimit = 10;
const exchanges = new Map<string, number[]>();
const deviceStarts = new Map<string, number[]>();

/** Small in-process guard. A hosted deployment should replace this with a shared limiter. */
function allowAttempts(attempts: Map<string, number[]>, ip: string, now: number) {
  const recent = (attempts.get(ip) ?? []).filter(at => now - at < exchangeWindowMs);
  if (recent.length >= exchangeLimit) {
    attempts.set(ip, recent);
    return false;
  }
  recent.push(now);
  attempts.set(ip, recent);
  if (attempts.size > 10_000) {
    for (const [key, times] of attempts) if (!times.some(at => now - at < exchangeWindowMs)) attempts.delete(key);
  }
  return true;
}

export function allowAgentExchange(ip: string, now = Date.now()) {
  return allowAttempts(exchanges, ip, now);
}

export function allowAgentDeviceStart(ip: string, now = Date.now()) {
  return allowAttempts(deviceStarts, ip, now);
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
