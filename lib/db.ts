import "server-only";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./database.ts";
import { env } from "./env.ts";

// One connection per process; survives dev hot reload.
const g = globalThis as unknown as { __phonelinkDb?: DatabaseSync };
export function db(): DatabaseSync {
  return (g.__phonelinkDb ??= openDatabase(env.dbPath));
}

export const now = () => new Date().toISOString();
