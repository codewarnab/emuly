import nextEnv from "@next/env";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "../lib/data/async-database.ts";
import { reencryptAll } from "../lib/auth/reencrypt.ts";

/** Rotation steps:
    1. Set EMULY_TOKEN_KEY to a new key and EMULY_TOKEN_KEY_OLD to the previous key. Deploy.
    2. Run `pnpm db:rotate-key`. It seals every old value again with the new key.
    3. When it reports 0 failures, remove EMULY_TOKEN_KEY_OLD and deploy again. */
try {
  nextEnv.loadEnvConfig(process.cwd());
  const current = process.env.EMULY_TOKEN_KEY;
  if (!current) throw new Error("EMULY_TOKEN_KEY is not set");
  const keys = [current, ...(process.env.EMULY_TOKEN_KEY_OLD ? [process.env.EMULY_TOKEN_KEY_OLD] : [])];
  const url = process.env.EMULY_DATABASE_URL;
  const authToken = process.env.EMULY_DATABASE_AUTH_TOKEN;
  if (url && (!/^(libsql|https):\/\//.test(url) || !authToken)) throw new Error("Invalid hosted database configuration");
  const client = createClient({
    url: url || pathToFileURL(resolve(process.env.EMULY_DB || ".data/emuly.db")).href,
    authToken: url ? authToken : undefined,
  });
  try {
    const result = await reencryptAll(client, keys);
    console.log(`Checked ${result.checked} values. Re-encrypted ${result.updated}. Failed ${result.failed.length}.`);
    for (const item of result.failed) console.log(`  could not decrypt: ${item}`);
    if (result.failed.length) {
      console.log("Keep EMULY_TOKEN_KEY_OLD until these rows are fixed or deleted.");
      process.exitCode = 1;
    } else {
      console.log("Done. You can now remove EMULY_TOKEN_KEY_OLD.");
    }
  } finally { client.close(); }
} catch (error) {
  console.error(`Key rotation failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}
