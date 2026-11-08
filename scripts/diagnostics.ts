import { createClient, type Client } from "@libsql/client";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { diagnosticReport } from "../lib/diagnostics/diagnostic-reports.ts";

// No dotenv, provider credentials, HTTP listener, or schema migration in the reader.
const [filename, mode = "list", operationId] = process.argv.slice(2);
if (!filename) {
  console.error("Usage: node scripts/diagnostics.ts <database-path> [list|timeline|aggregate|health] [operation-id]");
  process.exitCode = 1;
} else {
  let database: Client | undefined;
  try {
    await access(filename);
    database = createClient({ url: pathToFileURL(resolve(filename)).href, concurrency: 1 });
    await database.execute("PRAGMA query_only = ON");
    console.log(JSON.stringify(await diagnosticReport(database, mode, operationId), null, 2));
  } catch { console.error("Diagnostic report unavailable. Check the database path, schema, and report arguments."); process.exitCode = 1; }
  finally { database?.close(); }
}
