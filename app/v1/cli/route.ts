import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The Emuly CLI (bin/emuly.mjs) of this server. An agent downloads it from the server that it already
 * calls, so the CLI and the server always match, and no package install is needed.
 * It is one file with no dependencies. The SHA-256 header lets the caller check the download.
 */
let cached: { body: string; sha256: string } | undefined;
async function cli() {
  if (cached && process.env.NODE_ENV === "production") return cached;
  const body = (await readFile(join(process.cwd(), "bin", "emuly.mjs"), "utf8")).split("\r").join("");
  cached = { body, sha256: createHash("sha256").update(body).digest("hex") };
  return cached;
}

function headers(sha256: string, length: number) {
  return {
    "Content-Type": "text/javascript; charset=utf-8",
    "Content-Length": String(length),
    "Content-Disposition": 'attachment; filename="emuly.mjs"',
    "Cache-Control": "no-cache",
    "X-Emuly-Cli-Sha256": sha256,
    "X-Content-Type-Options": "nosniff",
  };
}

export async function GET() {
  const { body, sha256 } = await cli();
  return new Response(body, { headers: headers(sha256, Buffer.byteLength(body)) });
}

/** The CLI asks with HEAD at start to learn if a newer copy exists. */
export async function HEAD() {
  const { body, sha256 } = await cli();
  return new Response(null, { headers: headers(sha256, Buffer.byteLength(body)) });
}
