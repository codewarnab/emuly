import "server-only";
import type { DatabaseSync } from "node:sqlite";
import { migrate, openDatabase } from "./database.ts";
import { env } from "./env.ts";

// One connection per process; survives dev hot reload.
const g = globalThis as unknown as { __phonelinkDb?: DatabaseSync };
// Module scope resets on hot reload, so new migrations run on the kept connection.
let migrated = false;
export function db(): DatabaseSync {
  if (!g.__phonelinkDb) {
    g.__phonelinkDb = openDatabase(env.dbPath);
  } else if (!migrated) {
    migrate(g.__phonelinkDb);
  }
  migrated = true;
  return g.__phonelinkDb;
}

export const now = () => new Date().toISOString();
