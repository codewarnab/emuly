import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./database.ts";
import { saveStreamQuality, streamQuality } from "./display-settings.ts";

test("stream quality defaults to Auto and saves per account without changing other settings", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    migrate(database);
    for (const id of [1, 2]) database.prepare(`INSERT INTO users
      (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
      VALUES (?, ?, 'fixture', ?, 'codespace', '2026-11-08', '2026-11-08')`).run(id, id, Buffer.from("fixture"));
    database.exec("INSERT INTO user_settings (user_id, default_idle_min) VALUES (1, 60)");
    assert.equal(streamQuality(database, 1), "auto");
    for (const value of ["sharp", "saver", "auto"] as const) {
      assert.equal(saveStreamQuality(database, 1, value).ok, true);
      assert.equal(streamQuality(database, 1), value);
      assert.equal(streamQuality(database, 2), "auto");
    }
    assert.equal(saveStreamQuality(database, 1, "sharp").ok, true);
    for (const value of [null, "1080p", {}, 1]) assert.equal(saveStreamQuality(database, 1, value).ok, false);
    assert.equal(streamQuality(database, 1), "sharp");
    assert.equal(database.prepare("SELECT default_idle_min FROM user_settings WHERE user_id = 1").get()?.default_idle_min, 60);
    migrate(database);
    assert.equal(streamQuality(database, 1), "sharp");
  } finally { database.close(); }
});
