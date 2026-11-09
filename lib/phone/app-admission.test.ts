import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase } from "../data/database.ts";
import { createClient } from "../data/async-database.ts";
import { sharedAppAdmission } from "./app-admission.ts";

test("Install admission reclaims a phone's own claim and ignores phones that cannot run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "emuly-admission-"));
  const filename = join(directory, "app.db");
  openDatabase(filename).close();
  const database = createClient({ url: pathToFileURL(filename).href });
  try {
    await database.execute("PRAGMA foreign_keys = ON");
    await database.execute({ sql: "INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at) VALUES (1, 1, 'owner', x'00', '', '2026-01-01', '2026-01-01')", args: [] });
    for (const [id, state] of [["one", "running"], ["two", "running"], ["three", "running"], ["gone", "stopped"]])
      await database.execute({ sql: "INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, state, created_at, runner_secret) VALUES (?, 1, ?, 'owner/repo', 'd4', ?, '2026-01-01', x'00')",
        args: [id, `phone-${id}`, state] });
    // A claim left behind by a stopped phone must not consume an account slot.
    await database.execute({ sql: "INSERT INTO app_admissions (phone_id, user_id, operation_key, expires_at) VALUES ('gone', 1, 'stale', unixepoch() + 1800)", args: [] });
    const admission = sharedAppAdmission(database);
    assert.equal(await admission.claim(1, "one", "first"), true);
    // A retry on the same phone replaces its previous claim instead of being rejected.
    assert.equal(await admission.claim(1, "one", "retry"), true);
    assert.equal(await admission.current(1, "one"), "retry");
    assert.equal(await admission.claim(1, "two", "other"), true);
    // The account still allows only two concurrent transfers, and those are the live phones.
    assert.equal(await admission.claim(1, "three", "third"), false);
    await admission.release(1, "one", "retry");
    assert.equal(await admission.current(1, "one"), undefined);
    assert.equal(await admission.claim(1, "three", "third"), true);
    // Release only drops the claim it names.
    await admission.release(1, "one", "retry");
    assert.equal(await admission.current(1, "two"), "other");
  } finally {
    database.close();
    // Native SQLite statements can retain Windows file handles until collection.
    globalThis.gc?.();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
