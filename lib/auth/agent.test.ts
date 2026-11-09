import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
import { createSetupCode, exchangeSetupCode, findAgentKey, revokeAgentKey,
  AGENT_KEY_PREFIX, SETUP_CODE_PREFIX, DEVICE_CODE_PREFIX, DEVICE_CODE_TTL_MS, DEVICE_POLL_INTERVAL_MS,
  approveDeviceCode, createDeviceCode, denyDeviceCode, getDeviceRequest, normalizeUserCode,
  pollDeviceCode } from "../data/agents.ts";
import { createSettingsApi } from "../data/settings-api.ts";
import { createWebhookApi } from "../webhooks/webhook-api.ts";
import type { createWebhookService } from "../webhooks/webhooks.ts";
import { resolveUser } from "./identity.ts";
import { agentKeyCommands } from "./agent.ts";
import { AGENT_DEVICE_MESSAGE, forbidAgent } from "./scope.ts";

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

test("device codes start, poll slowly, approve and mint one key exactly once", async () => {
  const client = await fixture();
  try {
    const started = await createDeviceCode(client, NOW);
    assert.match(started.deviceCode, new RegExp(`^${DEVICE_CODE_PREFIX}[A-Za-z0-9_-]{43}$`));
    assert.match(started.userCode, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.doesNotMatch(started.userCode.replace("-", ""), /[01IO]/);
    assert.equal(started.expiresAt, new Date(NOW + DEVICE_CODE_TTL_MS).toISOString());
    assert.equal(started.expiresIn, 600);
    assert.equal(started.interval, 5);

    const stored = (await client.execute("SELECT device_code_hash, user_code, status FROM agent_device_codes")).rows[0]!;
    assert.equal(stored.device_code_hash, createHash("sha256").update(started.deviceCode).digest("base64url"));
    assert.notEqual(stored.device_code_hash, started.deviceCode);
    assert.equal(stored.user_code, started.userCode);
    assert.equal(stored.status, "pending");

    assert.deepEqual(await pollDeviceCode(client, started.deviceCode, NOW), { status: "pending" });
    assert.deepEqual(await pollDeviceCode(client, started.deviceCode, NOW + 1_000), { status: "slow_down" });
    assert.deepEqual(await pollDeviceCode(client, started.deviceCode, NOW + DEVICE_POLL_INTERVAL_MS), { status: "pending" });

    assert.equal(await approveDeviceCode(client, started.userCode.toLowerCase(), 1, NOW + DEVICE_POLL_INTERVAL_MS + 1_000), "approved");
    const approved = (await client.execute("SELECT status, user_id FROM agent_device_codes")).rows[0]!;
    assert.equal(approved.status, "approved");
    assert.equal(approved.user_id, 1);

    const success = await pollDeviceCode(client, started.deviceCode, NOW + DEVICE_POLL_INTERVAL_MS + 2_000);
    assert.equal(success.status, "approved");
    if (success.status !== "approved") assert.fail("expected a key");
    assert.match(success.key, new RegExp(`^${AGENT_KEY_PREFIX}[A-Za-z0-9_-]{43}$`));
    const storedKey = (await client.execute("SELECT name, key_hash FROM agent_keys")).rows[0]!;
    assert.equal(storedKey.name, "Agent device login");
    assert.equal(storedKey.key_hash, createHash("sha256").update(success.key).digest("base64url"));
    assert.deepEqual(await pollDeviceCode(client, started.deviceCode, NOW + DEVICE_POLL_INTERVAL_MS + 3_000), { status: "used" });
    assert.equal((await getDeviceRequest(client, started.userCode, NOW + DEVICE_POLL_INTERVAL_MS + 3_000))?.status, "used");
    assert.equal(Number((await client.execute("SELECT count(*) AS n FROM agent_keys")).rows[0]!.n), 1);
  } finally {
    client.close();
  }
});

test("device codes can be denied or expire, and an unknown code is invalid", async () => {
  const client = await fixture();
  try {
    const denied = await createDeviceCode(client, NOW);
    assert.equal(await denyDeviceCode(client, denied.userCode, NOW + 1_000), "denied");
    assert.deepEqual(await pollDeviceCode(client, denied.deviceCode, NOW + 1_000), { status: "denied" });
    assert.equal((await getDeviceRequest(client, denied.userCode, NOW + 1_000))?.status, "denied");
    assert.equal(await approveDeviceCode(client, denied.userCode, 1, NOW + 1_000), "denied");

    const expired = await createDeviceCode(client, NOW);
    const late = NOW + DEVICE_CODE_TTL_MS + 1;
    assert.deepEqual(await pollDeviceCode(client, expired.deviceCode, late), { status: "expired" });
    assert.equal((await getDeviceRequest(client, expired.userCode, late))?.status, "expired");
    assert.equal(await approveDeviceCode(client, expired.userCode, 1, late), "expired");

    assert.deepEqual(await pollDeviceCode(client, `${DEVICE_CODE_PREFIX}${"a".repeat(43)}`, NOW), { status: "invalid" });
    assert.equal(await getDeviceRequest(client, "NOPE-9999", NOW), null);
  } finally {
    client.close();
  }
});

test("user codes are normalized and reject ambiguous characters", () => {
  assert.equal(normalizeUserCode("wxyz-2345"), "WXYZ-2345");
  assert.equal(normalizeUserCode(" wxyz 2345 "), "WXYZ-2345");
  assert.equal(normalizeUserCode("WXYZ2345"), "WXYZ-2345");
  assert.equal(normalizeUserCode("WXYZ-234O"), null);
  assert.equal(normalizeUserCode("WXYZ-2340"), null);
  assert.equal(normalizeUserCode("WXYZ-234I"), null);
  assert.equal(normalizeUserCode("WXYZ-2341"), null);
  assert.equal(normalizeUserCode("short"), null);
  assert.equal(normalizeUserCode(1234), null);
});

test("agent keys cannot approve device sign-ins", async () => {
  const denied = forbidAgent({ authKind: "agent" }, AGENT_DEVICE_MESSAGE);
  assert.equal(denied?.status, 403);
  assert.match((await denied!.json()).message, /cannot approve/);
  assert.equal(forbidAgent({ authKind: "session" }, AGENT_DEVICE_MESSAGE), null);
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
