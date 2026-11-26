import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostedClientFromFiles } from "./hosted-client.ts";

test("hostedClientFromFiles refuses a non-hosted URL or an empty token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "emuly-hosted-"));
  try {
    const url = join(dir, "url.txt"), token = join(dir, "token.txt");
    writeFileSync(url, "file:local.db\n"); writeFileSync(token, "t\n");
    await assert.rejects(hostedClientFromFiles(url, token), /Invalid hosted database configuration/);
    writeFileSync(url, "libsql://db.example.turso.io\n"); writeFileSync(token, "\n");
    await assert.rejects(hostedClientFromFiles(url, token), /Invalid hosted database configuration/);
    writeFileSync(token, "secret\n");
    const client = await hostedClientFromFiles(url, token);
    client.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
