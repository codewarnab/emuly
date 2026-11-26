import "server-only";
import { ipAddress } from "@vercel/functions";
import { isIP } from "node:net";
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

/** The 8 groups of an IPv6 address, or undefined. */
function ipv6Groups(ip: string) {
  if (isIP(ip) !== 6) return undefined;
  let text = ip.toLowerCase().split("%")[0]!;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  const fill = text.includes("::") ? 8 - left.length - right.length : 0;
  return [...left, ...Array(fill).fill("0"), ...right].map(group => parseInt(group, 16));
}

/**
 * One address and its wider network. One IPv6 user often holds a whole /64, so the /64 counts as one
 * address. The wider network is an IPv6 /48 or an IPv4 /24. ::ffff:a.b.c.d counts as a.b.c.d.
 */
export function ipNetworks(ip: string): { address: string, network: string } {
  const groups = ipv6Groups(ip);
  if (groups && groups.slice(0, 5).every(group => !group) && groups[5] === 0xffff)
    return ipNetworks(`${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`);
  if (groups) {
    const hex = groups.map(group => group.toString(16));
    return { address: `${hex.slice(0, 4).join(":")}::/64`, network: `${hex.slice(0, 3).join(":")}::/48` };
  }
  if (isIP(ip) === 4) return { address: ip, network: `${ip.split(".").slice(0, 3).join(".")}.0/24` };
  return { address: ip, network: ip };
}

/** Ten hits a minute for each address (or IPv6 /64), and twenty for each /24 or /48 network. */
async function allowAttempts(bucket: string, ip: string, database: Client, now: number) {
  const { address, network } = ipNetworks(ip);
  const limits = [[bucket, sha256(address), 10], [`${bucket}_network`, sha256(network), 20]] as const;
  return transaction(database, async queries => {
    await queries.execute({ sql: "DELETE FROM rate_limit_hits WHERE ts <= ?", args: [now - 60_000] });
    for (const [name, key, limit] of limits) {
      const count = Number((await queries.execute({ sql: "SELECT count(*) AS n FROM rate_limit_hits WHERE bucket = ? AND key = ?",
        args: [name, key] })).rows[0]!.n);
      if (count >= limit) return false;
    }
    for (const [name, key] of limits)
      await queries.execute({ sql: "INSERT INTO rate_limit_hits (bucket, key, ts) VALUES (?, ?, ?)", args: [name, key, now] });
    return true;
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
    clear: "reg delete HKCU\\Environment /v EMULY_KEY /f",
  };
}
