import "server-only";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./database.ts";
import { env } from "../env.ts";

// One connection per process; survives dev hot reload.
const g = globalThis as unknown as { __phonelinkDb?: DatabaseSync };
export function db(): DatabaseSync {
  if (process.env.PHONELINK_DATABASE_URL) {
    throw new Error("Hosted database migration is incomplete: this feature still uses synchronous SQLite.");
  }
  if (!g.__phonelinkDb) g.__phonelinkDb = openDatabase(env.dbPath, false);
  return g.__phonelinkDb;
}

export const now = () => new Date().toISOString();
