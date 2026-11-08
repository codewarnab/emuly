import { DatabaseSync } from "node:sqlite";
import { diagnosticReport } from "../lib/diagnostics/diagnostic-reports.ts";

// No dotenv, provider credentials, HTTP listener, or schema migration in the reader.
const [filename, mode = "list", operationId] = process.argv.slice(2);
if (!filename) {
  console.error("Usage: node scripts/diagnostics.ts <database-path> [list|timeline|aggregate|health] [operation-id]");
  process.exitCode = 1;
} else {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(filename, { readOnly: true });
    console.log(JSON.stringify(diagnosticReport(database, mode, operationId), null, 2));
  } catch { console.error("Diagnostic report unavailable. Check the database path, schema, and report arguments."); process.exitCode = 1; }
  finally { database?.close(); }
}
