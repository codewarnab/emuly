import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createClient } from "../lib/data/async-database.ts";
import { importDatabase } from "../lib/data/import-database.ts";
import { migrateHosted } from "../lib/data/hosted-migrations.ts";

const [sourcePath, urlFile, tokenFile] = process.argv.slice(2);
if (!sourcePath || !urlFile || !tokenFile) throw new Error("Usage: import-database.ts <offline-snapshot.db> <url-file> <token-file>");
if (!(await stat(sourcePath)).isFile()) throw new Error("Source must be an existing offline snapshot");
const source = createClient({ url: pathToFileURL(resolve(sourcePath)).href });
const target = createClient({ url: (await readFile(urlFile, "utf8")).trim(), authToken: (await readFile(tokenFile, "utf8")).trim() });
try {
  await migrateHosted(target);
  const counts = await importDatabase(source, target);
  console.log(JSON.stringify({ imported: true, counts }));
} catch { console.error("Import failed. Provider details suppressed. Keep the source deployment active."); process.exitCode = 1; }
finally { source.close(); target.close(); }
