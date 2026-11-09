import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createClient } from "./async-database.ts";
import { migrateHosted } from "./hosted-migrations.ts";
import {
  PHONE_DELETE_TTL_MS, claimPhoneDeleteRequest, completePhoneDeleteRequest, createPhoneDeleteRequest,
  denyPhoneDeleteRequest, finishPhoneDeleteRequest, getPhoneDeleteRequest, getPhoneDeleteRequestByToken,
  listAgentPhoneDeletions, recordAgentPhoneDeletion, reopenPhoneDeleteRequest,
} from "./phone-deletions.ts";

const NOW = Date.parse("2026-11-09T12:00:00Z");

async function fixture() {
  const client = createClient({ url: "file::memory:" });
  await migrateHosted(client);
  await client.execute(`INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
    VALUES (1, 123, 'test-user', X'00', 'codespace', '2026-01-01', '2026-01-01')`);
  await client.execute(`INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, state, created_at, runner_secret)
    VALUES ('phone-quiet-falcon', 1, 'codespace-quiet', 'fixture/template', 'fixture-machine', 'running', '2026-01-01', X'00')`);
  await client.execute(`INSERT INTO agent_keys (user_id, name, key_hash, created_at, expires_at)
    VALUES (1, 'Claude Code on DESKTOP', 'hash-1', '2026-01-01', '2027-01-01')`);
  const key = (await client.execute("SELECT id FROM agent_keys WHERE key_hash = 'hash-1'")).rows[0]!;
  return { client, keyId: Number(key.id) };
}

test("delete requests stay pending, claim exactly once and finish as done", async () => {
  const { client, keyId } = await fixture();
  try {
    const created = await createPhoneDeleteRequest(client, { userId: 1, phoneId: "phone-quiet-falcon", agentKeyId: keyId }, NOW);
    assert.match(created.id, /^pdr_/);
    assert.equal(created.expiresIn, 600);
    assert.equal(created.interval, 5);
    const row = (await client.execute("SELECT token_hash, status FROM phone_delete_requests")).rows[0]!;
    assert.equal(row.token_hash, createHash("sha256").update(created.token).digest("base64url"));
    assert.notEqual(row.token_hash, created.token);
    assert.equal(row.status, "pending");

    const pending = await getPhoneDeleteRequest(client, 1, "phone-quiet-falcon", created.id, NOW);
    assert.equal(pending?.status, "pending");
    assert.equal((await getPhoneDeleteRequestByToken(client, created.token, 1, NOW))?.phoneId, "phone-quiet-falcon");
    assert.equal(await getPhoneDeleteRequest(client, 2, "phone-quiet-falcon", created.id, NOW), null);
    assert.equal(await getPhoneDeleteRequestByToken(client, "not-a-token", 1, NOW), null);

    const first = await claimPhoneDeleteRequest(client, created.token, 1, NOW + 1000);
    assert.deepEqual(first, { status: "approved", claimed: true, phoneId: "phone-quiet-falcon", agentKeyId: keyId });
    const second = await claimPhoneDeleteRequest(client, created.token, 1, NOW + 2000);
    assert.equal(second.claimed, false, "a second approval cannot claim the request");
    assert.equal(second.status, "approved");

    await completePhoneDeleteRequest(client, created.id);
    assert.equal((await getPhoneDeleteRequest(client, 1, "phone-quiet-falcon", created.id, NOW + 3000))?.status, "done");
    assert.equal(await claimPhoneDeleteRequest(client, created.token, 1, NOW + 4000).then(result => result.claimed), false);
  } finally { client.close(); }
});

test("a denied request stays denied and cannot be approved later", async () => {
  const { client } = await fixture();
  try {
    const created = await createPhoneDeleteRequest(client, { userId: 1, phoneId: "phone-quiet-falcon" }, NOW);
    assert.equal(await denyPhoneDeleteRequest(client, created.token, 1, NOW + 1000), "denied");
    assert.equal(await denyPhoneDeleteRequest(client, created.token, 1, NOW + 2000), "denied");
    const claim = await claimPhoneDeleteRequest(client, created.token, 1, NOW + 2000);
    assert.equal(claim.claimed, false);
    assert.equal(claim.status, "denied");
    assert.equal((await getPhoneDeleteRequestByToken(client, created.token, 1, NOW + 2000))?.status, "denied");
  } finally { client.close(); }
});

test("an expired request cannot be claimed and reports expired", async () => {
  const { client } = await fixture();
  try {
    const created = await createPhoneDeleteRequest(client, { userId: 1, phoneId: "phone-quiet-falcon" }, NOW);
    const late = NOW + PHONE_DELETE_TTL_MS + 1;
    assert.equal((await getPhoneDeleteRequest(client, 1, "phone-quiet-falcon", created.id, late))?.status, "expired");
    assert.equal((await getPhoneDeleteRequestByToken(client, created.token, 1, late))?.status, "expired");
    const claim = await claimPhoneDeleteRequest(client, created.token, 1, late);
    assert.equal(claim.claimed, false);
    assert.equal(claim.status, "expired");
    assert.equal(await denyPhoneDeleteRequest(client, created.token, 1, late), "expired");
  } finally { client.close(); }
});

test("a failed deletion can be reopened until it expires", async () => {
  const { client } = await fixture();
  try {
    const created = await createPhoneDeleteRequest(client, { userId: 1, phoneId: "phone-quiet-falcon" }, NOW);
    await claimPhoneDeleteRequest(client, created.token, 1, NOW + 1000);
    await reopenPhoneDeleteRequest(client, created.id, NOW + 2000);
    assert.equal((await getPhoneDeleteRequest(client, 1, "phone-quiet-falcon", created.id, NOW + 3000))?.status, "pending");

    await claimPhoneDeleteRequest(client, created.token, 1, NOW + 4000);
    await reopenPhoneDeleteRequest(client, created.id, NOW + PHONE_DELETE_TTL_MS + 5000);
    assert.equal((await getPhoneDeleteRequest(client, 1, "phone-quiet-falcon", created.id,
      NOW + PHONE_DELETE_TTL_MS + 6000))?.status, "expired");
  } finally { client.close(); }
});

test("a request survives the phone row so the agent can see done", async () => {
  const { client } = await fixture();
  try {
    const created = await createPhoneDeleteRequest(client, { userId: 1, phoneId: "phone-quiet-falcon" }, NOW);
    await claimPhoneDeleteRequest(client, created.token, 1, NOW + 1000);
    await client.execute("DELETE FROM phones WHERE id = 'phone-quiet-falcon'");
    await completePhoneDeleteRequest(client, created.id);
    assert.equal((await getPhoneDeleteRequest(client, 1, "phone-quiet-falcon", created.id, NOW + 2000))?.status, "done");
  } finally { client.close(); }
});

test("settling a missing phone marks the request done", async () => {
  const { client } = await fixture();
  try {
    const created = await createPhoneDeleteRequest(client, { userId: 1, phoneId: "phone-quiet-falcon" }, NOW);
    await finishPhoneDeleteRequest(client, created.id);
    assert.equal((await getPhoneDeleteRequest(client, 1, "phone-quiet-falcon", created.id, NOW + 1000))?.status, "done");
  } finally { client.close(); }
});

test("agent deletions keep the phone name and agent key name after the phone is gone", async () => {
  const { client, keyId } = await fixture();
  try {
    assert.equal(await recordAgentPhoneDeletion(client, { userId: 1, phoneName: "Quiet Falcon", agentKeyId: keyId }, NOW), true);
    assert.equal(await recordAgentPhoneDeletion(client, { userId: 1, phoneName: "No Agent", agentKeyId: null }, NOW), false);
    await client.execute("DELETE FROM phones WHERE id = 'phone-quiet-falcon'");
    const rows = await listAgentPhoneDeletions(client, 1);
    assert.deepEqual(rows.map(row => ({ ...row, id: undefined, deleted_at: undefined })), [
      { id: undefined, phone_name: "Quiet Falcon", agent_key_name: "Claude Code on DESKTOP", deleted_at: undefined },
    ]);
    assert.equal(rows[0]!.deleted_at, new Date(NOW).toISOString());
  } finally { client.close(); }
});
