import type { Client, InValue } from "@libsql/client";
import { MIGRATIONS } from "./migrations.ts";
import { transaction } from "./async-database.ts";

/** Source must be an offline snapshot. Target must be migrated and empty. */
export async function importDatabase(source: Client, target: Client) {
  const tables = MIGRATIONS.flatMap(sql => [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)].map(match => match[1]!))
    .filter(name => !["coordination_leases", "stream_tickets", "app_admissions", "backups"].includes(name));
  const snapshot = new Map<string, Record<string, InValue>[]>();
  const read = await source.transaction("read");
  try {
    const existing = new Set((await read.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map(row => String(row.name)));
    for (const name of tables) {
      snapshot.set(name, existing.has(name) ? (await read.execute(`SELECT * FROM "${name}"`)).rows as unknown as Record<string, InValue>[] : []);
    }
    await read.commit();
  } finally { read.close(); }
  return transaction(target, async queries => {
    for (const name of tables) {
      if (Number((await queries.execute(`SELECT count(*) AS n FROM "${name}"`)).rows[0]!.n)) throw new Error("Import target must be empty");
    }
    const counts: Record<string, number> = {};
    for (const [name, rows] of snapshot) {
      for (const row of rows) {
        const columns = Object.keys(row);
        await queries.execute({ sql: `INSERT INTO "${name}" (${columns.map(c => `"${c}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          args: columns.map(c => row[c]!) });
      }
      counts[name] = rows.length;
    }
    if ((await queries.execute("PRAGMA foreign_key_check")).rows.length) throw new Error("Import failed foreign-key validation");
    return counts;
  });
}
