import { createClient } from "./async-database.ts";
import { pathToFileURL } from "node:url";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database.ts";
import { choosePlan, chosenPlan, clearAllowanceOverride, userSettings, updateSettings, SettingsInputError, saveHoursSetting } from "./settings.ts";
import { createSettingsApi } from "./settings-api.ts";

test("settings default to Free, 30-minute idle and auto-stop off; partial updates persist without touching another user", async () => {
  const directory = mkdtempSync(join(tmpdir(), "phonelink-settings-"));
  const filename = join(directory, "test.db");
  openDatabase(filename).close();
  let database = createClient({ url: pathToFileURL(filename).href });
  try {
    for (const id of [1, 2]) await database.execute({ sql: `INSERT INTO users
      (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
      VALUES (?, ?, 'fixture', ?, 'codespace', '2026-11-01', '2026-11-01')`, args: [id, id, Buffer.from("fixture")] });
    const defaults = { allowance_core_hours: 120, default_machine: null, default_idle_min: 30, auto_stop_before_empty: false, auto_keep: false };
    assert.deepEqual(await userSettings(database, 1), defaults);
    await database.execute("INSERT INTO billing_settings (user_id, plan_name) VALUES (1, 'pro')");
    assert.equal((await userSettings(database, 1)).allowance_core_hours, 180);
    await updateSettings(database, 1, { default_machine: "fixture-2-core", default_idle_min: 240 });
    assert.equal((await userSettings(database, 1)).allowance_core_hours, 180, "machine saves keep automatic allowance");
    for (const allowance_core_hours of [180, 1, 0]) {
      await updateSettings(database, 1, { allowance_core_hours });
      assert.deepEqual(await userSettings(database, 1), { ...defaults, allowance_core_hours,
        default_machine: "fixture-2-core", default_idle_min: 240 });
    }
    await updateSettings(database, 1, { auto_stop_before_empty: true, auto_keep: true });
    database.close();
    database = createClient({ url: pathToFileURL(filename).href });
    const saved = await userSettings(database, 1);
    assert.deepEqual(saved, { allowance_core_hours: 0, default_machine: "fixture-2-core", default_idle_min: 240, auto_stop_before_empty: true, auto_keep: true });
    assert.deepEqual(await userSettings(database, 2), defaults);
    await clearAllowanceOverride(database, 1);
    assert.equal((await userSettings(database, 1)).allowance_core_hours, 180);
    await updateSettings(database, 1, { allowance_core_hours: 0 });
    for (const invalid of [null, [], {}, { user_id: 2 }, { auto_keep: 1 }, { default_idle_min: 4 }, { default_idle_min: 241 }, { default_idle_min: 30.5 },
      { allowance_core_hours: -1 }, { allowance_core_hours: Infinity }, { allowance_core_hours: "120" },
      { auto_stop_before_empty: 1 }, { default_machine: "bad/path" },
      { allowance_core_hours: 120, default_idle_min: 0 }]) {
      await assert.rejects(updateSettings(database, 1, invalid), SettingsInputError);
      assert.deepEqual(await userSettings(database, 1), saved);
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
    for (const body of ["{", "[]", '{"user_id":2}', '{"default_idle_min":241}']) {
      assert.equal((await patch(request(body))).status, 400);
    }
    assert.deepEqual(await userSettings(database, 1), saved);
    const response = await patch(request());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { ...saved, auto_stop_before_empty: false, auto_keep: false });
    assert.deepEqual(await userSettings(database, 2), defaults);
  } finally {
    database.close();
    // Native SQLite statements can retain Windows file handles until collection.
    globalThis.gc?.();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("onboarding plan choice sets the allowance and replaces a manual override", async () => {
  const directory = mkdtempSync(join(tmpdir(), "phonelink-plan-"));
  const filename = join(directory, "test.db");
  openDatabase(filename).close();
  const database = createClient({ url: pathToFileURL(filename).href });
  try {
    await database.execute({ sql: `INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
      VALUES (1, 1, 'fixture', ?, 'codespace', '2026-11-01', '2026-11-01')`, args: [Buffer.from("fixture")] });
    assert.equal(await chosenPlan(database, 1), null, "new users have not chosen yet");
    await updateSettings(database, 1, { allowance_core_hours: 50 });
    assert.equal(await chosenPlan(database, 1), null, "a manual allowance is not a plan choice");
    await choosePlan(database, 1, "pro");
    assert.equal(await chosenPlan(database, 1), "pro");
    assert.equal((await userSettings(database, 1)).allowance_core_hours, 180);
    await choosePlan(database, 1, "free");
    assert.equal((await userSettings(database, 1)).allowance_core_hours, 120);
  } finally {
    database.close();
    // Native SQLite statements can retain Windows file handles until collection.
    globalThis.gc?.(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
test("Hours field saves validate runtime input and preserve other controls and users", async () => {
  const directory = mkdtempSync(join(tmpdir(), "phonelink-hours-field-"));
  const filename = join(directory, "test.db");
  openDatabase(filename).close();
  const database = createClient({ url: pathToFileURL(filename).href });
  try {
    for (const id of [1, 2]) await database.execute({ sql: `INSERT INTO users
      (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
      VALUES (?, ?, 'fixture', ?, 'codespace', '2026-11-01', '2026-11-01')`, args: [id, id, Buffer.from("fixture")] });
    const other = await userSettings(database, 2);
    for (const [field, value] of [["idle", 45], ["autoStop", true], ["autoKeep", true], ["plan", 0]] as const) {
      assert.deepEqual(await saveHoursSetting(database, 1, field, value), { ok: true, message: "Saved" });
    }
    const saved = await userSettings(database, 1);
    assert.deepEqual(saved, { ...other, default_idle_min: 45, auto_stop_before_empty: true, auto_keep: true, allowance_core_hours: 0 });
    for (const [field, value] of [["idle", "30"], ["idle", 4], ["idle", 241], ["idle", 30.5], ["autoStop", "true"],
      ["autoKeep", 1], ["plan", "custom"], ["plan", ""], ["plan", -1], ["plan", NaN], ["plan", Infinity],
      ["plan", null], ["plan", true], ["unknown", 30]] as const) {
      const result = await saveHoursSetting(database, 1, field, value);
      assert.equal(result.ok, false, `${field} must reject ${String(value)}`);
      assert.ok(result.message);
      assert.deepEqual(await userSettings(database, 1), saved);
    }
    assert.equal((await saveHoursSetting(database, 1, "plan", "pro")).ok, true);
    assert.equal((await userSettings(database, 1)).allowance_core_hours, 180);
    assert.equal((await saveHoursSetting(database, 1, "plan", "free")).ok, true);
    assert.equal((await userSettings(database, 1)).allowance_core_hours, 120);
    assert.equal((await userSettings(database, 1)).default_idle_min, 45);
    assert.deepEqual(await userSettings(database, 2), other);
  } finally {
    database.close();
    // Native SQLite statements can retain Windows file handles until collection.
    globalThis.gc?.();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
