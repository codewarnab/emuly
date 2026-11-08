import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
import { saveStreamQuality, streamQuality } from "./display-settings.ts";

test("stream quality defaults to Auto and saves per account without changing other settings", async () => {
  const database = createClient({ url: "file::memory:" });
  try {
    await migrateHosted(database);
    for (const id of [1, 2]) await database.execute({ sql: `INSERT INTO users
      (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
      VALUES (?, ?, 'fixture', ?, 'codespace', '2026-11-08', '2026-11-08')`, args: [id, id, Buffer.from("fixture")] });
    await database.execute("INSERT INTO user_settings (user_id, default_idle_min) VALUES (1, 60)");
    assert.equal(await streamQuality(database, 1), "auto");
    for (const value of ["sharp", "saver", "auto"] as const) {
      assert.equal((await saveStreamQuality(database, 1, value)).ok, true);
      assert.equal(await streamQuality(database, 1), value);
      assert.equal(await streamQuality(database, 2), "auto");
    }
    assert.equal((await saveStreamQuality(database, 1, "sharp")).ok, true);
    for (const value of [null, "1080p", {}, 1]) assert.equal((await saveStreamQuality(database, 1, value)).ok, false);
    assert.equal(await streamQuality(database, 1), "sharp");
    assert.equal((await database.execute("SELECT default_idle_min FROM user_settings WHERE user_id = 1")).rows[0]?.default_idle_min, 60);
    await migrateHosted(database);
    assert.equal(await streamQuality(database, 1), "sharp");
  } finally { database.close(); }
});
