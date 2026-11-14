import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
import { PHONE_DELETE_TTL_MS, createPhoneDeleteRequest,
  getPhoneDeleteRequestByToken } from "../data/phone-deletions.ts";
import { createPhoneDeleteApproval } from "./phone-delete-approval.ts";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const phone = { id: "phone-quiet-falcon", name: "Quiet Falcon" };

async function fixture() {
  const client = createClient({ url: "file::memory:" });
  let time = NOW;
  await migrateHosted(client);
  await client.execute(`INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
    VALUES (1, 123, 'test-user', X'00', 'codespace', '2026-01-01', '2026-01-01')`);
  await client.execute(`INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, state, created_at)
    VALUES ('phone-quiet-falcon', 1, 'codespace-quiet', 'fixture/template', 'fixture-machine', 'running', '2026-01-01')`);
  await client.execute(`INSERT INTO agent_keys (id, user_id, name, key_hash, created_at, expires_at)
    VALUES (42, 1, 'Claude Code', 'hash-42', '2026-01-01', '2027-01-01')`);
  const created = await createPhoneDeleteRequest(client, { userId: 1, phoneId: phone.id, agentKeyId: 42 }, NOW);
  return { client, token: created.token, requestId: created.id, now: () => time, advance: (ms: number) => { time += ms; } };
}

function approval(client: Parameters<typeof createPhoneDeleteApproval>[0]["database"],
  options: { agent?: boolean; removeOk?: boolean; now?: () => number } = {}) {
  let removals = 0;
  const approval = createPhoneDeleteApproval({
    database: client,
    user: { id: 1, authKind: options.agent ? "agent" : "session" },
    phone: async (_userId, id) => id === phone.id ? phone : undefined,
    remove: async () => { removals++; return options.removeOk === false
      ? { ok: false as const, message: "GitHub refused." } : { ok: true as const }; },
    record: async () => true,
    now: options.now,
  });
  return { approval, removals: () => removals };
}

test("an agent key cannot approve or deny a deletion request", async () => {
  const { client, token, requestId, now } = await fixture();
  try {
    const { approval: handler, removals } = approval(client, { agent: true, now });
    const approved = await handler.approve(token, phone.name);
    assert.equal(approved.ok, false);
    assert.match(approved.message, /browser/);
    assert.equal(removals(), 0);
    assert.equal((await getPhoneDeleteRequestByToken(client, token, 1, now()))?.status, "pending");

    const denied = await handler.deny(token);
    assert.equal(denied.ok, false);
    assert.match(denied.message, /browser/);
    assert.equal((await getPhoneDeleteRequestByToken(client, token, 1, now()))?.status, "pending");
    assert.equal(requestId.length > 0, true);
  } finally { client.close(); }
});

test("approval needs the exact phone name and deletes only once", async () => {
  const { client, token, now, advance } = await fixture();
  try {
    const { approval: handler, removals } = approval(client, { now });
    const wrong = await handler.approve(token, "quiet falcon");
    assert.equal(wrong.ok, false);
    assert.equal(removals(), 0);

    advance(1000);
    const first = await handler.approve(token, phone.name);
    assert.equal(first.ok, true);
    assert.equal(first.message, "Phone deleted.");
    assert.equal(removals(), 1);
    assert.equal((await getPhoneDeleteRequestByToken(client, token, 1, now()))?.status, "done");

    advance(1000);
    const second = await handler.approve(token, phone.name);
    assert.equal(second.ok, false);
    assert.match(second.message, /already deleted/);
    assert.equal(removals(), 1, "a finished request never deletes twice");
  } finally { client.close(); }
});

test("a failed deletion reopens the request for another try", async () => {
  const { client, token, now } = await fixture();
  try {
    const { approval: handler, removals } = approval(client, { removeOk: false, now });
    const failed = await handler.approve(token, phone.name);
    assert.equal(failed.ok, false);
    assert.match(failed.message, /GitHub refused/);
    assert.equal((await getPhoneDeleteRequestByToken(client, token, 1, NOW + 1000))?.status, "pending");
    assert.equal(removals(), 1);
  } finally { client.close(); }
});

test("denying keeps the phone and an expired request cannot be approved", async () => {
  const { client, token, now, advance } = await fixture();
  try {
    const { approval: handler, removals } = approval(client, { now });
    const denied = await handler.deny(token);
    assert.equal(denied.ok, true);
    assert.match(denied.message, /not deleted/);
    assert.equal((await getPhoneDeleteRequestByToken(client, token, 1, now()))?.status, "denied");

    advance(PHONE_DELETE_TTL_MS + 1);
    const expired = await createPhoneDeleteRequest(client, { userId: 1, phoneId: phone.id }, now());
    advance(PHONE_DELETE_TTL_MS + 1);
    const late = await handler.approve(expired.token, phone.name);
    assert.equal(late.ok, false);
    assert.match(late.message, /expired/);
    assert.equal(removals(), 0);
    assert.equal((await getPhoneDeleteRequestByToken(client, expired.token, 1, now()))?.status, "expired");
  } finally { client.close(); }
});
