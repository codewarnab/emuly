import type { Client } from "@libsql/client";
import { transaction } from "./async-database.ts";
import { monthStart } from "./usage.ts";

type Child = { table: string; column: string; children: Child[] };

/** Tables whose rows point at `parent`, and the tables that point at those, read from the schema.
    The purge deletes them itself, because foreign keys may be off on a hosted connection. */
async function childTables(database: Client, parent: string, seen = new Set<string>()): Promise<Child[]> {
  const tables = (await database.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL")).rows;
  const found: Child[] = [];
  for (const row of tables) {
    const table = String(row.name);
    if (seen.has(table)) continue;
    const match = new RegExp(`(\\w+)\\s+\\w+[^,(]*?REFERENCES\\s+${parent}\\s*\\(id\\)`, "i").exec(String(row.sql));
    if (!match) continue;
    seen.add(table);
    found.push({ table, column: match[1]!, children: await childTables(database, table, seen) });
  }
  return found;
}

/** Removes phones that a user deleted, with every row that belongs to them.
    A phone stays until its last run ends before the current month, so the hours budget keeps it. */
export async function purgeDeletedPhones(database: Client, clock: () => number = Date.now, limit = 50) {
  const ids = (await database.execute({ sql: `SELECT id FROM phones p WHERE state = 'deleted'
    AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.phone_id = p.id AND (r.stopped_at IS NULL OR r.stopped_at >= ?))
    LIMIT ?`, args: [monthStart(clock()), limit] })).rows.map(row => String(row.id));
  if (!ids.length) return 0;
  const children = await childTables(database, "phones");
  for (const id of ids) {
    await transaction(database, async queries => {
      const remove = async (child: Child, parentIds: string) => {
        const select = `SELECT id FROM "${child.table}" WHERE "${child.column}" IN (${parentIds})`;
        for (const grandchild of child.children) await remove(grandchild, select);
        await queries.execute({ sql: `DELETE FROM "${child.table}" WHERE "${child.column}" IN (${parentIds})`, args: Array(parentIds.split("?").length - 1).fill(id) });
      };
      for (const child of children) await remove(child, "?");
      await queries.execute({ sql: "DELETE FROM phones WHERE id = ? AND state = 'deleted'", args: [id] });
    });
  }
  return ids.length;
}
