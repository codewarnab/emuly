import { createClient, type Client } from "@libsql/client";
import { access, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { diagnosticReport } from "../lib/diagnostics/diagnostic-reports.ts";

// No dotenv, provider credentials, HTTP listener, or schema migration in the reader.
// A hosted database: pass a file with the libsql:// URL, and --token <file> with a short-lived token.
const args = process.argv.slice(2), at = args.indexOf("--token");
const tokenFile = at >= 0 ? args.splice(at, 2)[1] : undefined;
const [filename, mode = "list", operationId] = args;
if (!filename) {
  console.error("Usage: node scripts/diagnostics.ts <database-path> [list|timeline|aggregate|health|api|states] [operation-id] [--token <file>]");
  process.exitCode = 1;
} else {
  let database: Client | undefined;
  try {
    await access(filename);
    database = tokenFile
      ? createClient({ url: (await readFile(filename, "utf8")).trim(), authToken: (await readFile(tokenFile, "utf8")).trim() })
      : createClient({ url: pathToFileURL(resolve(filename)).href, concurrency: 1 });
    await database.execute("PRAGMA query_only = ON");
    console.log(JSON.stringify(await diagnosticReport(database, mode, operationId), null, 2));
  } catch { console.error("Diagnostic report unavailable. Check the database path, schema, and report arguments."); process.exitCode = 1; }
  finally { database?.close(); }
}
