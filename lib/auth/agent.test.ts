import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
import { createSetupCode, exchangeSetupCode, findAgentKey, revokeAgentKey,
  AGENT_KEY_PREFIX, SETUP_CODE_PREFIX } from "../data/agents.ts";
import { createSettingsApi } from "../data/settings-api.ts";
import { createWebhookApi } from "../webhooks/webhook-api.ts";
import type { createWebhookService } from "../webhooks/webhooks.ts";
import { resolveUser } from "./identity.ts";
import { agentKeyCommands } from "./agent.ts";

const NOW = Date.parse("2026-11-09T12:00:00Z");

async function fixture() {
  const client = createClient({ url: "file::memory:" });
  await migrateHosted(client);
  await client.execute(`INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
    VALUES (1, 123, 'test-user', X'00', 'codespace', '2026-01-01', '2026-01-01')`);
  return client;
}

test("setup codes exchange once, store only hashes and reject reused or expired codes", async () => {
  const client = await fixture();
  try {
    const { code, expiresAt } = await createSetupCode(client, 1, NOW);
    assert.match(code, new RegExp(`^${SETUP_CODE_PREFIX}[A-Za-z0-9_-]{43}$`));
    assert.equal(expiresAt, new Date(NOW + 60 * 60 * 1000).toISOString());
    const storedCode = (await client.execute("SELECT code_hash FROM agent_setup_codes")).rows[0]!;
    assert.equal(storedCode.code_hash, createHash("sha256").update(code).digest("base64url"));
    assert.notEqual(storedCode.code_hash, code);

    const exchanged = await exchangeSetupCode(client, code, "Claude Code on DESKTOP-ABC", NOW);
    assert.ok(exchanged);
    assert.match(exchanged.key, new RegExp(`^${AGENT_KEY_PREFIX}[A-Za-z0-9_-]{43}$`));
    assert.equal(exchanged.expiresAt, new Date(NOW + 90 * 24 * 60 * 60 * 1000).toISOString());

    const stored = (await client.execute("SELECT name, key_hash FROM agent_keys")).rows[0]!;
    assert.equal(stored.name, "Claude Code on DESKTOP-ABC");
    assert.equal(stored.key_hash, createHash("sha256").update(exchanged.key).digest("base64url"));
    assert.notEqual(stored.key_hash, exchanged.key);

    assert.equal(await exchangeSetupCode(client, code, "Reuse", NOW), null, "the same code cannot be used twice");

    const old = await createSetupCode(client, 1, NOW - 2 * 60 * 60 * 1000);
    assert.equal(await exchangeSetupCode(client, old.code, "Late", NOW), null, "an expired code is rejected");

    const identity = await findAgentKey(client, exchanged.key, NOW + 1_000);
    assert.deepEqual(identity && { userId: identity.userId, name: identity.name }, { userId: 1, name: "Claude Code on DESKTOP-ABC" });
    const used = (await client.execute({ sql: "SELECT last_used_at FROM agent_keys WHERE id = ?", args: [identity!.keyId] })).rows[0]!;
    assert.equal(used.last_used_at, new Date(NOW + 1_000).toISOString());

    assert.equal(await revokeAgentKey(client, 1, identity!.keyId, NOW + 2_000), true);
    assert.equal(await findAgentKey(client, exchanged.key, NOW + 3_000), null, "revoked keys stop working");

    const expired = await exchangeSetupCode(client, (await createSetupCode(client, 1, NOW)).code, "Expired key", NOW);
    await client.execute({ sql: "UPDATE agent_keys SET expires_at = ? WHERE key_hash = ?",
      args: [new Date(NOW - 1).toISOString(), createHash("sha256").update(expired!.key).digest("base64url")] });
    assert.equal(await findAgentKey(client, expired!.key, NOW), null, "expired keys stop working");
  } finally {
    client.close();
  }
});

test("getUser resolves a bearer key first and does not fall back to the browser session", async () => {
  const client = await fixture();
  const session = { id: "stored-session", userId: 1, expiresAt: new Date(NOW + 86_400_000).toISOString() };
  try {
    const { key } = (await exchangeSetupCode(client, (await createSetupCode(client, 1, NOW)).code,
      "Claude Code on DESKTOP-ABC", NOW))!;
    const agent = await resolveUser({ authorization: `Bearer ${key}`, session, database: client, now: NOW + 500 });
    assert.equal(agent?.id, 1);
    assert.equal(agent?.authKind, "agent");
    assert.ok(agent?.agentKeyId);

    const browser = await resolveUser({ authorization: null, session, database: client, now: NOW });
    assert.equal(browser?.authKind, "session");

    const invalid = await resolveUser({ authorization: `Bearer ${AGENT_KEY_PREFIX}${"a".repeat(43)}`,
      session, database: client, now: NOW });
    assert.equal(invalid, null, "an invalid key must not quietly use the cookie");

    await revokeAgentKey(client, 1, agent!.agentKeyId!, NOW + 1_000);
    assert.equal(await resolveUser({ authorization: `Bearer ${key}`, session, database: client, now: NOW + 2_000 }), null);
  } finally {
    client.close();
  }
});

test("agent keys are blocked from settings and from changing or deleting webhooks", async () => {
  const client = await fixture();
  try {
    const user = async () => ({ id: 1, authKind: "agent" as const });
    const patch = createSettingsApi({ database: client, user });
    const settings = await patch(new Request("https://emuly.test/v1/settings", { method: "PATCH",
      headers: { "content-type": "application/json" }, body: "{}" }));
    assert.equal(settings.status, 403);
    assert.equal((await settings.json()).error, "forbidden");

    const service = {
      list: async () => [],
      create: async () => ({ id: "wh_1" }),
    } as unknown as ReturnType<typeof createWebhookService>;
    const api = createWebhookApi({ user, service });
    assert.equal((await api(new Request("https://emuly.test/v1/webhooks", { method: "GET" }))).status, 200);
    assert.equal((await api(new Request("https://emuly.test/v1/webhooks", { method: "POST",
      headers: { "content-type": "application/json" }, body: '{"url":"https://example.com/emuly"}' }))).status, 201);
    const remove = await api(new Request("https://emuly.test/v1/webhooks/wh_1", { method: "DELETE" }), "wh_1");
    assert.equal(remove.status, 403);
    assert.match((await remove.json()).message, /cannot change, test or delete/);
    assert.equal((await api(new Request("https://emuly.test/v1/webhooks/wh_1", { method: "PATCH" }), "wh_1")).status, 403);
  } finally {
    client.close();
  }
});

test("key commands store the key in the EMULY_KEY user variable and refuse unsafe keys", () => {
  const key = `${AGENT_KEY_PREFIX}${"a".repeat(43)}`;
  assert.deepEqual(agentKeyCommands(key), {
    save: `setx EMULY_KEY "${key}"`,
    read: "[Environment]::GetEnvironmentVariable('EMULY_KEY','User')",
    clear: 'setx EMULY_KEY ""',
  });
  assert.throws(() => agentKeyCommands(`${AGENT_KEY_PREFIX}a" & calc`));
});
