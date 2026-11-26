import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "@libsql/client";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
import { insertSession, readSession, sessionCookieShape } from "./session-store.ts";
import { resolveUser } from "./identity.ts";

test("a dashboard page load reads Turso once for the session and the signed-in user", async () => {
  const client = createClient({ url: "file::memory:" });
  try {
    await migrateHosted(client);
    await client.execute(`INSERT INTO users (id, github_id, login, name, token_cipher, token_scopes, created_at, last_seen_at)
      VALUES (1, 123, 'test-user', 'Test User', X'00', 'codespace', '2026-01-01', '2026-01-01')`);
    const { value } = await insertSession(client, 1);
    let reads = 0;
    const counted = { execute: (query: never) => { reads += 1; return client.execute(query); } } as unknown as Client;

    const session = await readSession(counted, value);
    const user = await resolveUser({ authorization: null, session, database: counted });
    assert.equal(reads, 1, "one read gives both the session and the user");
    assert.deepEqual(user && { id: user.id, login: user.login, name: user.name, initials: user.initials, authKind: user.authKind },
      { id: 1, login: "test-user", name: "Test User", initials: "TU", authKind: "session" });

    await client.execute("UPDATE users SET blocked = 1 WHERE id = 1");
    assert.equal(await readSession(client, value), null, "a blocked user still has no session");
  } finally {
    client.close();
  }
});

test("the proxy checks only the cookie format and reads no database", () => {
  const source = readFileSync("proxy.ts", "utf8");
  assert.doesNotMatch(source, /asyncDb|readSession/);
  assert.match(source, /sessionCookieShape\(value\)/);
  assert.equal(sessionCookieShape(undefined), false);
  assert.equal(sessionCookieShape("short"), false);
  assert.equal(sessionCookieShape("a".repeat(43)), true);
});
