import nextEnv from "@next/env";
import { readFile } from "node:fs/promises";
import { createClient } from "../lib/data/async-database.ts";
import { migrateHosted } from "../lib/data/hosted-migrations.ts";

try {
  nextEnv.loadEnvConfig(process.cwd());
  // `--local-only` (npm run dev) never touches a hosted database: dev must not migrate production.
  const localOnly = process.argv.includes("--local-only");
  const [urlFile, tokenFile] = process.argv.slice(2).filter(arg => arg !== "--local-only");
  const url = urlFile ? (await readFile(urlFile, "utf8")).trim() : process.env.EMULY_DATABASE_URL;
  const authToken = tokenFile ? (await readFile(tokenFile, "utf8")).trim() : process.env.EMULY_DATABASE_AUTH_TOKEN;
  if (url && localOnly) {
    console.log("A hosted database is set, so dev start skips migrations. Run npm run db:migrate.");
  } else if (url) {
    if (!/^(libsql|https):\/\//.test(url) || !authToken) throw new Error("Invalid hosted database configuration");
    const client = createClient({ url, authToken });
    try { await migrateHosted(client); } finally { client.close(); }
  } else {
    const { openDatabase } = await import("../lib/data/database.ts");
    openDatabase(process.env.EMULY_DB || ".data/emuly.db").close();
  }
  console.log("Database migrations complete.");
} catch (error) {
  // Name, code and migration version only: a provider message can hold the URL or the token.
  const details = error && typeof error === "object" ? error as { name?: unknown; code?: unknown; migrationVersion?: unknown } : {};
  const parts = [`name=${String(details.name ?? typeof error)}`, details.code !== undefined ? `code=${String(details.code)}` : "",
    details.migrationVersion !== undefined ? `migration=${String(details.migrationVersion)}` : ""].filter(Boolean);
  console.error(`Database migration failed (${parts.join(" ")}). Credentials and provider messages are not logged.`);
  process.exitCode = 1;
}
