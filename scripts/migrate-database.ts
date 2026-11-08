import nextEnv from "@next/env";
import { readFile } from "node:fs/promises";
import { createClient } from "../lib/data/async-database.ts";
import { migrateHosted } from "../lib/data/hosted-migrations.ts";

try {
  nextEnv.loadEnvConfig(process.cwd());
  const [urlFile, tokenFile] = process.argv.slice(2);
  const url = urlFile ? (await readFile(urlFile, "utf8")).trim() : process.env.PHONELINK_DATABASE_URL;
  const authToken = tokenFile ? (await readFile(tokenFile, "utf8")).trim() : process.env.PHONELINK_DATABASE_AUTH_TOKEN;
  if (url) {
    if (!/^(libsql|https):\/\//.test(url) || !authToken) throw new Error("Invalid hosted database configuration");
    const client = createClient({ url, authToken });
    try { await migrateHosted(client); } finally { client.close(); }
  } else {
    const { openDatabase } = await import("../lib/data/database.ts");
    openDatabase(process.env.PHONELINK_DB || ".data/phonelink.db").close();
  }
  console.log("Database migrations complete.");
} catch {
  console.error("Database migration failed. Credentials and provider errors are not logged.");
  process.exitCode = 1;
}
