import type { Client } from "@libsql/client";
import { contexts, isLegacy, openWithKey, seal } from "./crypto-core.ts";

type Column = { table: string; column: string; select: string; context: (row: Record<string, unknown>) => string };

/** Every encrypted column. Add a new one here when a table gains a sealed value. */
const columns: Column[] = [
  { table: "users", column: "token_cipher", select: "id, github_id", context: row => contexts.githubAccess(Number(row.github_id)) },
  { table: "users", column: "refresh_cipher", select: "id, github_id", context: row => contexts.githubRefresh(Number(row.github_id)) },
  { table: "webhooks", column: "secret_cipher", select: "id", context: row => contexts.webhookSecret(String(row.id)) },
  { table: "phones", column: "runner_secret", select: "id", context: row => contexts.runnerSecret(String(row.id)) },
];

export type ReencryptResult = { checked: number; updated: number; failed: string[] };

/** Seals again every value that an old key encrypted or that has no row context (version 1).
    keys[0] is the new key. The update only applies when the value is unchanged, so a token
    refresh that runs at the same time is never overwritten. Values are never logged. */
export async function reencryptAll(database: Client, keys: readonly string[]): Promise<ReencryptResult> {
  if (!keys.length) throw new Error("At least one key is required");
  const result: ReencryptResult = { checked: 0, updated: 0, failed: [] };
  for (const { table, column, select, context } of columns) {
    const rows = (await database.execute(`SELECT ${select}, ${column} AS box FROM ${table} WHERE ${column} IS NOT NULL`)).rows;
    for (const row of rows) {
      const record = row as unknown as Record<string, unknown>;
      const box = new Uint8Array(record.box as ArrayBuffer);
      if (box.length < 29) continue; // Placeholder values, not real secrets.
      result.checked++;
      const label = context(record);
      let opened;
      try { opened = openWithKey(box, keys, label); }
      catch { result.failed.push(`${table}.${column} id=${String(record.id)}`); continue; }
      if (opened.keyIndex === 0 && !isLegacy(box)) continue;
      const update = await database.execute({
        sql: `UPDATE ${table} SET ${column} = ? WHERE id = ? AND ${column} = ?`,
        args: [seal(opened.plain, keys[0]!, label), record.id as string | number, box],
      });
      result.updated += update.rowsAffected;
    }
  }
  return result;
}
