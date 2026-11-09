import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccessToken } from "./github-token.ts";
import { asyncDb } from "../data/async-db.ts";
import { openDatabase } from "../data/database.ts";
import { seal, open } from "../auth/crypto.ts";
import { insertSession } from "../auth/session-store.ts";

test("tokens refresh once for concurrent callers, persist encrypted, and invalidate sessions on failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "emuly-token-test-"));
  process.env.EMULY_DB = join(directory, "test.db");
  process.env.EMULY_TOKEN_KEY = randomBytes(32).toString("base64");
  process.env.EMULY_GITHUB_CLIENT_ID = "synthetic-client";
  process.env.EMULY_GITHUB_CLIENT_SECRET = "synthetic-secret";
  const database = openDatabase(process.env.EMULY_DB!);
  const client = asyncDb();
  let calls = 0;
  let refuse = false;
  const timestamp = Date.parse("2026-11-07T00:00:00.000Z");
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(input, "https://github.com/login/oauth/access_token");
    assert.equal(init?.method, "POST");
    const body = init?.body as URLSearchParams;
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), refuse ? "synthetic-new-refresh" : "synthetic-refresh");
    if (refuse) return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json({
      access_token: "synthetic-new-access", refresh_token: "synthetic-new-refresh",
      expires_in: 28_800, refresh_token_expires_in: 15_552_000, scope: "codespace", token_type: "bearer",
    });
  };
  const options = { fetch: fetcher, clock: () => timestamp };
  try {
    database.prepare(`INSERT INTO users (github_id, login, token_cipher, token_expires_at, refresh_cipher,
      refresh_expires_at, token_scopes, created_at, last_seen_at) VALUES (123, 'test-user', ?, ?, ?, ?, 'codespace', ?, ?)`)
      .run(seal("synthetic-old-access"), new Date(timestamp + 240_000).toISOString(), seal("synthetic-refresh"),
        new Date(timestamp + 86_400_000).toISOString(), "2026-01-01", "2026-01-01");
    const userId = Number(database.prepare("SELECT id FROM users").get()?.id);
    const values = await Promise.all([getAccessToken(userId, options), getAccessToken(userId, options), getAccessToken(userId, options)]);
    assert.ok(values.every(value => value === "synthetic-new-access"));
    assert.equal(calls, 1);
    const row = database.prepare("SELECT token_cipher, refresh_cipher, token_expires_at FROM users").get() as
      { token_cipher: Uint8Array; refresh_cipher: Uint8Array; token_expires_at: string };
    assert.equal(open(row.token_cipher), "synthetic-new-access");
    assert.equal(open(row.refresh_cipher), "synthetic-new-refresh");
    assert.equal(row.token_expires_at, "2026-11-07T08:00:00.000Z");
    assert.equal(await getAccessToken(userId, options), "synthetic-new-access");
    assert.equal(calls, 1);
    await insertSession(client, userId);
    database.prepare("UPDATE users SET token_expires_at = ?").run("2000-01-01");
    refuse = true;
    await assert.rejects(getAccessToken(userId, options), /^Error: Sign in again$/);
    assert.equal(database.prepare("SELECT count(*) AS n FROM sessions").get()?.n, 0);
    // A rejected refresh must leave no stale promise in the map.
    await insertSession(client, userId);
    await assert.rejects(getAccessToken(userId, options), /^Error: Sign in again$/);
    assert.equal(database.prepare("SELECT count(*) AS n FROM sessions").get()?.n, 0);
  } finally {
    client.close();
    database.close();
    globalThis.gc?.();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
