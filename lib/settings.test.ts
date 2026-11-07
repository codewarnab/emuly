import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database.ts";
import { userSettings, updateSettings, SettingsInputError } from "./settings.ts";
import { createSettingsApi } from "./settings-api.ts";

test("settings default to Free, 30-minute idle and auto-stop off; partial updates persist without touching another user", async () => {
  const directory = mkdtempSync(join(tmpdir(), "phonelink-settings-"));
  const filename = join(directory, "test.db");
  let database = openDatabase(filename);
  try {
    for (const id of [1, 2]) database.prepare(`INSERT INTO users
      (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
      VALUES (?, ?, 'fixture', ?, 'codespace', '2026-11-01', '2026-11-01')`).run(id, id, Buffer.from("fixture"));
    const defaults = { allowance_core_hours: 120, default_machine: null, default_idle_min: 30, auto_stop_before_empty: false, auto_keep: false };
    assert.deepEqual(userSettings(database, 1), defaults);
    updateSettings(database, 1, { default_machine: "fixture-2-core", default_idle_min: 240 });
    for (const allowance_core_hours of [180, 1, 0]) {
      updateSettings(database, 1, { allowance_core_hours });
      assert.deepEqual(userSettings(database, 1), { ...defaults, allowance_core_hours,
        default_machine: "fixture-2-core", default_idle_min: 240 });
    }
    updateSettings(database, 1, { auto_stop_before_empty: true, auto_keep: true });
    database.close();
    database = openDatabase(filename);
    const saved = userSettings(database, 1);
    assert.deepEqual(saved, { allowance_core_hours: 0, default_machine: "fixture-2-core", default_idle_min: 240, auto_stop_before_empty: true, auto_keep: true });
    assert.deepEqual(userSettings(database, 2), defaults);
    for (const invalid of [null, [], {}, { user_id: 2 }, { auto_keep: 1 }, { default_idle_min: 60 },
      { allowance_core_hours: -1 }, { allowance_core_hours: Infinity }, { allowance_core_hours: "120" },
      { auto_stop_before_empty: 1 }, { default_machine: "bad/path" },
      { allowance_core_hours: 120, default_idle_min: 0 }]) {
      assert.throws(() => updateSettings(database, 1, invalid), SettingsInputError);
      assert.deepEqual(userSettings(database, 1), saved);
    }

    let signedIn = false;
    const patch = createSettingsApi({ database, user: async () => signedIn ? { id: 1 } : null });
    const request = (body = '{"auto_stop_before_empty":false,"auto_keep":false}', headers: Record<string, string> = {}) =>
      new Request("http://localhost/v1/settings", { method: "PATCH", body, headers: { "Content-Type": "application/json", ...headers } });
    assert.equal((await patch(request())).status, 401);
    signedIn = true;
    assert.equal((await patch(request(undefined, { Origin: "https://foreign.invalid" }))).status, 403);
    assert.equal((await patch(request(undefined, { "sec-fetch-site": "cross-site" }))).status, 403);
    assert.equal((await patch(request(undefined, { "Content-Type": "text/plain" }))).status, 415);
    for (const body of ["{", "[]", '{"user_id":2}', '{"default_idle_min":31}']) {
      assert.equal((await patch(request(body))).status, 400);
    }
    assert.deepEqual(userSettings(database, 1), saved);
    const response = await patch(request());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { ...saved, auto_stop_before_empty: false, auto_keep: false });
    assert.deepEqual(userSettings(database, 2), defaults);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
