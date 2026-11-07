import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccessToken } from "./github-token.ts";
import { db } from "./db.ts";
import { seal, open } from "./crypto.ts";
import { insertSession } from "./session-store.ts";

test("tokens refresh once for concurrent callers, persist encrypted, and invalidate sessions on failure", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "phonelink-token-test-"));
  process.env.PHONELINK_DB = join(directory, "test.db");
  process.env.PHONELINK_TOKEN_KEY = randomBytes(32).toString("base64");
  process.env.PHONELINK_GITHUB_CLIENT_ID = "synthetic-client";
  process.env.PHONELINK_GITHUB_CLIENT_SECRET = "synthetic-secret";
  const database = db();
  let calls = 0;
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(input, "https://github.com/login/oauth/access_token");
    assert.equal(init?.method, "POST");
    const body = init?.body as URLSearchParams;
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "synthetic-refresh");
    return Response.json({
      access_token: "synthetic-new-access", refresh_token: "synthetic-new-refresh",
      expires_in: 28_800, refresh_token_expires_in: 15_552_000, scope: "codespace", token_type: "bearer",
    });
  });
  try {
    database.prepare(`INSERT INTO users (github_id, login, token_cipher, token_expires_at, refresh_cipher,
      refresh_expires_at, token_scopes, created_at, last_seen_at) VALUES (123, 'test-user', ?, ?, ?, ?, 'codespace', ?, ?)`)
      .run(seal("synthetic-old-access"), new Date(Date.now() + 240_000).toISOString(), seal("synthetic-refresh"),
        new Date(Date.now() + 86_400_000).toISOString(), "2026-01-01", "2026-01-01");
    const userId = Number(database.prepare("SELECT id FROM users").get()?.id);
    const values = await Promise.all([getAccessToken(userId), getAccessToken(userId), getAccessToken(userId)]);
    assert.ok(values.every(value => value === "synthetic-new-access"));
    assert.equal(calls, 1);
    const row = database.prepare("SELECT token_cipher, refresh_cipher, token_expires_at FROM users").get() as
      { token_cipher: Uint8Array; refresh_cipher: Uint8Array; token_expires_at: string };
    assert.equal(open(row.token_cipher), "synthetic-new-access");
    assert.equal(open(row.refresh_cipher), "synthetic-new-refresh");
    assert.ok(Date.parse(row.token_expires_at) > Date.now() + 7 * 3_600_000);
    assert.equal(await getAccessToken(userId), "synthetic-new-access");
    assert.equal(calls, 1);
    insertSession(database, userId);
    database.prepare("UPDATE users SET token_expires_at = ?").run("2000-01-01");
    fetchMock.mock.mockImplementation(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
    await assert.rejects(getAccessToken(userId), /^Error: Sign in again$/);
    assert.equal(database.prepare("SELECT count(*) AS n FROM sessions").get()?.n, 0);
    // A rejected refresh must leave no stale promise in the map.
    insertSession(database, userId);
    await assert.rejects(getAccessToken(userId), /^Error: Sign in again$/);
    assert.equal(database.prepare("SELECT count(*) AS n FROM sessions").get()?.n, 0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
