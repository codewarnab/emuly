import type { Client } from "@libsql/client";
import { MIGRATIONS } from "./migrations.ts";

/** Deployment operation only. A dedicated transaction serializes concurrent deployers. */
export async function migrateHosted(client: Client) {
  await client.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
  for (let version = 1; version <= MIGRATIONS.length; version++) {
    const tx = await client.transaction("write");
    try {
      const latest = Number((await tx.execute("SELECT COALESCE(max(version), 0) AS version FROM schema_migrations")).rows[0].version);
      if (latest > MIGRATIONS.length) throw new Error("Database schema is newer than this application");
      if (latest < version) {
        await tx.executeMultiple(MIGRATIONS[version - 1]!);
        await tx.execute({ sql: "INSERT INTO schema_migrations (version) VALUES (?)", args: [version] });
      }
      await tx.commit();
    } catch (error) {
      try { await tx.rollback(); } catch { /* Preserve the migration error. */ }
      throw error;
    } finally { tx.close(); }
  }
}
