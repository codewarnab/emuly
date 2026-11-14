import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../data/db.ts";
import { asyncDb } from "../data/async-db.ts";
import { rm } from "node:fs/promises";
import { openDatabase } from "../data/database.ts";
import { listPhones, findPhone, phoneCard } from "./phones.ts";
import { phoneStatus } from "./phone-status.ts";

test("phone lists, cards, and detail share persisted setup failure and handle records without attempts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "emuly-status-"));
  const previousPath = process.env.EMULY_DB;
  process.env.EMULY_DB = join(directory, "test.db");
  openDatabase(process.env.EMULY_DB!).close();
  const database = db();
  try {
    database.exec(`INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
      VALUES (1, 1, 'fixture', X'00', 'codespace', '2026-11-08', '2026-11-08');
      INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, state, state_detail, created_at)
      VALUES ('phone-aaaa', 1, 'fixture-space', 'fixture/template', 'fixture-machine', 'booting', 'New wording.', '2026-11-08');
      INSERT INTO phone_setup_attempts (phone_id, failed, attempt_id) VALUES ('phone-aaaa', 1, 'fixture-attempt');`);
    const detail = (await findPhone(1, "phone-aaaa"))!;
    const listed = (await listPhones(1))[0];
    assert.equal(detail.setup_failed, 1);
    assert.equal(listed.setup_failed, 1);
    assert.equal(phoneCard(listed).statusLabel, "setup failed");
    assert.equal(phoneStatus(detail).label, "setup failed");
    database.exec("DELETE FROM phone_setup_attempts; UPDATE phones SET state_detail = 'Phone setup failed. Historical wording.';");
    assert.equal((await findPhone(1, "phone-aaaa"))!.setup_failed, 0);
    assert.equal(phoneStatus((await listPhones(1))[0]).kind, "booting");
  } finally {
    asyncDb().close();
    database.close();
    globalThis.gc?.();
    if (previousPath === undefined) delete process.env.EMULY_DB;
    else process.env.EMULY_DB = previousPath;
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
