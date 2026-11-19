import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
import { DIRECT_BLOCKED_HINT, directBlocked, recordDirectResult } from "./network-hint.ts";

test("a blocked report shows for 3 days, and a direct path that opens clears it", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await migrateHosted(db);
    await db.execute("INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at) VALUES (1, 11, 'a', X'00', 'codespace', '2026-01-01', '2026-01-01'), (2, 22, 'b', X'00', 'codespace', '2026-01-01', '2026-01-01')");
    const now = 1_800_000_000_000, day = 86_400_000;
    assert.equal(await directBlocked(db, 1, now), false);
    await recordDirectResult(db, 1, true, now);
    assert.equal(await directBlocked(db, 1, now + 2 * day), true);
    assert.equal(await directBlocked(db, 1, now + 3 * day), false, "an old report expires");
    assert.equal(await directBlocked(db, 2, now), false, "one user's network does not affect another user");
    await recordDirectResult(db, 1, false, now);
    assert.equal(await directBlocked(db, 1, now), false);
  } finally { db.close(); }
});

test("the hint is plain text with https sources an agent can quote", () => {
  assert.ok(DIRECT_BLOCKED_HINT.sources.length >= 2);
  for (const source of DIRECT_BLOCKED_HINT.sources) assert.match(source.url, /^https:\/\//);
  for (const line of [DIRECT_BLOCKED_HINT.message, ...DIRECT_BLOCKED_HINT.fix]) {
    for (const sentence of line.split(/(?<=\.) /)) assert.ok(sentence.split(/\s+/).length <= 20, sentence);
  }
});
