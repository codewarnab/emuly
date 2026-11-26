import { readFile } from "node:fs/promises";
import { createClient } from "./async-database.ts";

/**
 * A client for the hosted (Turso) database from two files: one with the URL and one with the
 * token. The files keep both out of the shell history. The token is never logged.
 */
export async function hostedClientFromFiles(urlFile: string, tokenFile: string) {
  const url = (await readFile(urlFile, "utf8")).trim();
  const authToken = (await readFile(tokenFile, "utf8")).trim();
  if (!/^(libsql|https):\/\//.test(url) || !authToken) throw new Error("Invalid hosted database configuration");
  return createClient({ url, authToken });
}
