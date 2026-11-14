import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
import { claimPhoneDeleteRequest } from "../data/phone-deletions.ts";
import { createPhoneDeleteApi, createPhoneDeleteRequestsApi } from "./phone-delete-api.ts";

const stored = { id: "phone-quiet-falcon", name: "Quiet Falcon" };
const base = "https://emuly.test";

function deleteFixture(overrides: Partial<Parameters<typeof createPhoneDeleteApi>[0]> = {}) {
  const calls: string[] = [];
  const api = createPhoneDeleteApi({
    user: async () => ({ id: 7, authKind: "agent", agentKeyId: 42 }),
    phone: async (userId, id) => { calls.push(`phone:${userId}:${id}`); return id === stored.id ? stored : undefined; },
    agentCanDelete: async userId => { calls.push(`switch:${userId}`); return false; },
    remove: async (userId, id) => { calls.push(`remove:${userId}:${id}`); return { ok: true }; },
    record: async (userId, name, keyId) => { calls.push(`record:${userId}:${name}:${keyId}`); return true; },
    baseUrl: () => base,
    ...overrides,
  });
  return { api, calls };
}

const del = (path = `/v1/phones/${stored.id}`, headers: Record<string, string> = {}) =>
  new Request(`${base}${path}`, { method: "DELETE", headers });

test("switch OFF rejects an agent DELETE with manage_url and never deletes", async () => {
  const { api, calls } = deleteFixture();
  const response = await api(del(), stored.id);
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error, "forbidden");
  assert.match(body.message, /Open manage_url/);
  assert.equal(body.manage_url, `${base}/app/settings/agents`);
  assert.deepEqual(calls, ["switch:7"]);
});

test("switch ON lets an agent DELETE once and returns settings_url", async () => {
  const { api, calls } = deleteFixture({ agentCanDelete: async () => true });
  const response = await api(del(), stored.id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true, settings_url: `${base}/app/settings/agents` });
  assert.deepEqual(calls, [`phone:7:${stored.id}`, `remove:7:${stored.id}`, `record:7:Quiet Falcon:42`]);
});

test("a session deletes directly and a missing phone is 404", async () => {
  const { api, calls } = deleteFixture({ user: async () => ({ id: 7, authKind: "session" }) });
  const response = await api(del(`/v1/phones/${stored.id}`, { origin: base }), stored.id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true });
  assert.deepEqual(calls, [`phone:7:${stored.id}`, `remove:7:${stored.id}`]);

  const missing = await api(del("/v1/phones/phone-other", { origin: base }), "phone-other");
  assert.equal(missing.status, 404);
});

test("a session DELETE without Origin is cross-origin and never reaches the phone", async () => {
  const { api, calls } = deleteFixture({ user: async () => ({ id: 7, authKind: "session" }) });
  const response = await api(del(), stored.id);
  assert.equal(response.status, 403);
  assert.deepEqual(calls, []);
});

test("delete request creation returns an approval link and polling reports status", async () => {
  const client = createClient({ url: "file::memory:" });
  await migrateHosted(client);
  await client.execute(`INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
    VALUES (1, 123, 'test-user', X'00', 'codespace', '2026-01-01', '2026-01-01')`);
  await client.execute(`INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, state, created_at)
    VALUES ('phone-quiet-falcon', 1, 'codespace-quiet', 'fixture/template', 'fixture-machine', 'running', '2026-01-01')`);
  await client.execute(`INSERT INTO agent_keys (id, user_id, name, key_hash, created_at, expires_at)
    VALUES (42, 1, 'Claude Code', 'hash-42', '2026-01-01', '2027-01-01')`);
  try {
    const api = createPhoneDeleteRequestsApi({ user: async () => ({ id: 1, authKind: "agent", agentKeyId: 42 }),
      phone: async (_userId, id) => id === stored.id ? stored : undefined, database: client, baseUrl: () => base });
    const created = await api.create(new Request(`${base}/v1/phones/${stored.id}/delete-requests`, { method: "POST" }), stored.id);
    assert.equal(created.status, 200);
    const body = await created.json();
    assert.match(body.request_id, /^pdr_/);
    assert.match(body.approve_url, new RegExp(`^${base}/app/phones/${stored.id}/delete\\?request=[A-Za-z0-9_-]{43}$`));
    assert.equal(body.expires_in, 600);
    assert.equal(body.interval, 5);

    const pending = await api.read(new Request(`${base}/v1/phones/${stored.id}/delete-requests/${body.request_id}`),
      stored.id, body.request_id);
    assert.deepEqual(await pending.json(), { request_id: body.request_id, status: "pending" });

    const token = new URL(body.approve_url).searchParams.get("request");
    await claimPhoneDeleteRequest(client, token, 1);
    const approved = await api.read(new Request(`${base}/x`), stored.id, body.request_id);
    assert.deepEqual(await approved.json(), { request_id: body.request_id, status: "approved" });

    const missing = await api.read(new Request(`${base}/x`), stored.id, "pdr_missing");
    assert.equal(missing.status, 404);
  } finally { client.close(); }
});
