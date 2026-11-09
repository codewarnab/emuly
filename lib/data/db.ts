import "server-only";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./database.ts";
import { env } from "../env.ts";

// One connection per process; survives dev hot reload.
const g = globalThis as unknown as { __emulyDb?: DatabaseSync };
export function db(): DatabaseSync {
  if (process.env.EMULY_DATABASE_URL) {
    throw new Error("Hosted database migration is incomplete: this feature still uses synchronous SQLite.");
  }
  if (!g.__emulyDb) g.__emulyDb = openDatabase(env.dbPath, false);
  return g.__emulyDb;
}

export const now = () => new Date().toISOString();
