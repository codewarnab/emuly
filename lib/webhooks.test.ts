import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database.ts";
import { seal, open } from "./crypto-core.ts";
import { createWebhookService } from "./webhooks.ts";
import { createWebhookOutbox } from "./webhook-outbox.ts";
import { createWebhookApi } from "./webhook-api.ts";
import { signWebhook, verifyWebhook, webhookTarget, type ResolveHost, type SendWebhook } from "./webhook-security.ts";
import { createStatePoller } from "./poller.ts";
import { createGitHubClient, type Codespace } from "./github.ts";
import { createPhoneService } from "./phone-mutations.ts";

const publicDns: ResolveHost = async () => [{ address: "93.184.216.34", family: 4 }];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "phonelink-webhook-"));
  const filename = join(directory, "test.db");
  let database = openDatabase(filename);
  const key = randomBytes(32).toString("base64");
  let time = Date.parse("2026-11-07T12:00:00Z");
  const clock = () => time;
  const encrypt = (value: string) => seal(value, key);
  const decrypt = (box: Uint8Array) => open(box, key);
  for (const id of [1, 2]) database.prepare(`INSERT INTO users
    (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
    VALUES (?, ?, 'fixture', ?, 'codespace', '2026-11-01', '2026-11-01')`).run(id, id, encrypt("synthetic-token"));
  const service = (resolve = publicDns, baseUrl = "https://phonelink.example", send?: SendWebhook) =>
    createWebhookService({ database, encrypt, clock, baseUrl, resolve,
      deliver: createWebhookOutbox({ database, decrypt, clock, baseUrl, resolve, send }) });
  return {
    get database() { return database; }, clock, service, encrypt, decrypt,
    advance(ms: number) { time += ms; },
    reopen() { database.close(); database = openDatabase(filename); },
    outbox(send?: SendWebhook, resolve = publicDns, baseUrl = "https://phonelink.example") {
      return createWebhookOutbox({ database, decrypt, clock, baseUrl, resolve, send });
    },
    close() { database.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("signatures match independent HMAC, reject tampering, old/future timestamps and malformed headers", () => {
  const body = '{"text":"Unicode ✓"}';
  const secret = "synthetic-signing-secret";
  const timestamp = 1_800_000_000;
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  assert.equal(signWebhook(secret, body, timestamp), `t=${timestamp},v1=${digest}`);
  const header = `t=${timestamp},v1=${digest}`;
  const clock = () => timestamp * 1000;
  assert.ok(verifyWebhook(secret, body, header, clock));
  assert.ok(verifyWebhook(secret, body, header, () => clock() + 300_000));
  assert.ok(!verifyWebhook(secret, body, header, () => clock() + 301_000));
  assert.ok(!verifyWebhook(secret, body, header, () => clock() - 301_000));
  assert.ok(!verifyWebhook(secret, `${body} `, header, clock));
  assert.ok(!verifyWebhook("wrong", body, header, clock));
  for (const invalid of ["", "t=NaN,v1=abc", `t=${timestamp},v1=00`, `${header},t=1`]) {
    assert.ok(!verifyWebhook(secret, body, invalid, clock));
  }
});

test("SSRF refuses private literals, private/mixed DNS answers and HTTP except configured localhost", async () => {
  const blocked = ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "0.0.0.0",
    "100.100.100.200", "224.0.0.1", "[::1]", "[fc00::1]", "[fdff::1]", "[fe80::1]", "[::ffff:127.0.0.1]",
    "[2002:7f00:1::]", "2130706433", "0x7f000001"];
  for (const host of blocked) await assert.rejects(webhookTarget(`https://${host}/hook`, "https://app.example", publicDns));
  for (const answers of [[{ address: "10.0.0.1", family: 4 }],
    [{ address: "93.184.216.34", family: 4 }, { address: "::1", family: 6 }], []]) {
    await assert.rejects(webhookTarget("https://receiver.example", "https://app.example", async () => answers));
  }
  for (const url of ["http://receiver.example", "ftp://receiver.example", "https://user:password@receiver.example", "https://receiver.example/#fragment",
    "http://localhost", "https://localhost"]) await assert.rejects(webhookTarget(url, "https://app.example", async () => [{ address: "127.0.0.1", family: 4 }]));
  const localDns: ResolveHost = async () => [{ address: "127.0.0.1", family: 4 }];
  assert.equal((await webhookTarget("http://localhost:9999/hook", "http://localhost:4321", localDns)).url.port, "9999");
  await assert.rejects(webhookTarget("http://127.0.0.1/hook", "http://localhost:4321", localDns));
  assert.equal((await webhookTarget("https://public.example/hook", "https://app.example", publicDns)).addresses[0]?.address, "93.184.216.34");
  assert.equal((await webhookTarget("https://[2606:4700::1111]/hook", "https://app.example", publicDns)).addresses[0]?.family, 6);
  assert.equal((await webhookTarget("https://[2001:4860:4860::8888]/hook", "https://app.example", publicDns)).addresses[0]?.family, 6);
});

test("fan-out honors ownership and subscriptions, stores encrypted secrets, and excludes credentials from payloads", async () => {
  const f = fixture();
  try {
    const service = f.service();
    const all = await service.create(1, { url: "https://receiver.example" });
    const selected = await service.create(1, { url: "https://selected.example", events: ["phone.stopped"] });
    await service.create(2, { url: "https://other.example" });
    const disabled = await service.create(1, { url: "https://disabled.example", enabled: false });
    assert.notEqual(Buffer.from(f.database.prepare("SELECT secret_cipher FROM webhooks WHERE id = ?").get(all.id)!.secret_cipher as Uint8Array).toString(), all.secret);
    assert.equal("secret" in service.list(1)[0]!, false);
    service.emit({ userId: 1, type: "phone.stopped", createdAt: new Date(f.clock()).toISOString(), data: {
      phone: { id: "phone-aaaa", name: "owned-space", state: "stopped", machine: "4 vCPU", runner_secret: "private-runner" },
      reason: "idle_timeout", token: "private-token", secret: "private-secret", stream_url: "https://stream.invalid/?secret=private",
      message: "GitHub refused gho_123456789012345678901234 https://stream.invalid/?token=private wss://private@stream.invalid",
    } });
    const deliveries = service.deliveries(1, all.id);
    assert.equal(deliveries.length, 1);
    assert.equal(service.deliveries(1, selected.id).length, 1);
    assert.equal(service.deliveries(1, disabled.id).length, 0);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM webhook_deliveries").get()?.n, 2);
    const body = String(f.database.prepare("SELECT body FROM webhook_deliveries WHERE id = ?").get(deliveries[0]!.id)!.body);
    assert.doesNotMatch(body, /private|gho_|stream.invalid|runner_secret/);
    const event = JSON.parse(body);
    assert.equal(event.version, 1); assert.match(event.id, /^evt_/); assert.equal(event.data.reason, "idle_timeout");
    const testDelivery = service.test(1, selected.id);
    assert.equal(service.deliveries(1, selected.id)[0]?.type, "webhook.test");
    assert.equal(service.deliveries(1, all.id).length, 1);
    const replay = service.resend(1, selected.id, testDelivery.id);
    assert.notEqual(replay.id, testDelivery.id);
    assert.equal(service.deliveries(1, selected.id)[0]?.event_id, service.deliveries(1, selected.id)[1]?.event_id);
    assert.throws(() => service.deliveries(2, all.id));
    assert.throws(() => service.test(2, all.id));
    assert.throws(() => service.remove(2, all.id));
    assert.throws(() => service.resend(1, selected.id, deliveries[0]!.id));
    await assert.rejects(service.update(2, all.id, { roll_secret: true }));
    const rotated = await service.update(1, all.id, { roll_secret: true });
    assert.notEqual(rotated.secret, all.secret);
    assert.equal(f.decrypt(f.database.prepare("SELECT secret_cipher FROM webhooks WHERE id = ?").get(all.id)!.secret_cipher as Uint8Array), rotated.secret);
    for (let i = 0; i < 55; i++) { f.advance(5000); service.test(1, all.id); }
    assert.equal(service.deliveries(1, all.id).length, 50);
    service.remove(1, all.id);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM webhook_deliveries WHERE webhook_id = ?").get(all.id)?.n, 0);
  } finally { f.close(); }
});

test("outbox persists five retry delays across restarts, then fails; resend preserves the event ID", async () => {
  const f = fixture();
  try {
    const hook = await f.service().create(1, { url: "https://receiver.example" });
    f.service().test(1, hook.id);
    const calls: { body: string; headers: Record<string, string> }[] = [];
    const send: SendWebhook = async (_target, body, headers, signal) => { assert.ok(!signal.aborted); calls.push({ body, headers }); return 503; };
    const delays = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000];
    for (let i = 0; i < delays.length; i++) {
      await f.outbox(send)();
      const delivery = f.service().deliveries(1, hook.id)[0]!;
      assert.equal(delivery.attempt, i + 1);
      assert.equal(delivery.next_try_at, new Date(f.clock() + delays[i]!).toISOString());
      assert.equal(delivery.state, "pending");
      f.advance(delays[i]! - 1); await f.outbox(send)(); assert.equal(calls.length, i + 1);
      f.advance(1); f.reopen();
    }
    await f.outbox(send)();
    const failed = f.service().deliveries(1, hook.id)[0]!;
    assert.equal(failed.attempt, 6); assert.equal(failed.state, "failed"); assert.equal(failed.next_try_at, null);
    await f.outbox(send)(); assert.equal(calls.length, 6);
    assert.ok(calls.every(call => call.headers["phonelink-delivery"] === failed.id));
    const rotated = await f.service().update(1, hook.id, { roll_secret: true });
    f.service().resend(1, hook.id, failed.id);
    await f.outbox(async (_target, body, headers) => {
      assert.equal(JSON.parse(body).id, failed.event_id);
      assert.ok(verifyWebhook(rotated.secret!, body, headers["phonelink-signature"]!, f.clock));
      assert.equal(headers["phonelink-event"], "webhook.test");
      return 204;
    })();
    assert.equal(f.service().deliveries(1, hook.id)[0]?.state, "ok");
    assert.equal(f.service().list(1)[0]?.failing_since, null);
  } finally { f.close(); }
});

test("only failures disable after three days without pending work; success resets the failure window", async () => {
  const f = fixture();
  try {
    const hook = await f.service().create(1, { url: "https://receiver.example" });
    const fail = async () => { throw new Error("synthetic network failure with private details"); };
    f.service().test(1, hook.id); await f.outbox(fail)();
    f.advance(2 * 86_400_000);
    await f.outbox(async () => 200)();
    assert.equal(f.service().list(1)[0]?.failing_since, null);
    f.service().test(1, hook.id); await f.outbox(fail)();
    // Exhaust retries before three days, leaving no pending delivery.
    for (const delay of [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]) { f.advance(delay); await f.outbox(fail)(); }
    assert.equal(f.service().deliveries(1, hook.id)[0]?.state, "failed");
    const since = Date.parse(f.service().list(1)[0]!.failing_since!);
    f.advance(since + 3 * 86_400_000 - 1 - f.clock()); await f.outbox(fail)();
    assert.equal(f.service().list(1)[0]?.enabled, true);
    f.advance(1); await f.outbox(fail)(); await f.outbox(fail)();
    // A quiet period after one failed event is not "3 days of only failures".
    assert.equal(f.service().list(1)[0]?.enabled, true);
    f.service().test(1, hook.id); await f.outbox(fail)();
    assert.equal(f.service().list(1)[0]?.enabled, false);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM events WHERE kind = 'webhook.disabled'").get()?.n, 1);
    await f.service().update(1, hook.id, { enabled: true });
    assert.equal(f.service().list(1)[0]?.failing_since, null);
    f.advance(5000); f.service().test(1, hook.id); await f.outbox(async () => 200)();
    assert.equal(f.service().deliveries(1, hook.id)[0]?.state, "ok");
  } finally { f.close(); }
});

test("delivery rechecks DNS after registration and refuses changed private answers without sending", async () => {
  const f = fixture();
  try {
    const hook = await f.service().create(1, { url: "https://receiver.example" });
    f.service().test(1, hook.id);
    let calls = 0;
    await f.outbox(async () => { calls++; return 200; }, async () => [{ address: "10.0.0.1", family: 4 }])();
    assert.equal(calls, 0); assert.equal(f.service().deliveries(1, hook.id)[0]?.status, null);
  } finally { f.close(); }
});

test("API enforces authentication, origin, ownership and validation; secrets appear only on create and roll", async () => {
  const f = fixture();
  try {
    let identity: { id: number } | null = null;
    const api = createWebhookApi({ user: async () => identity, service: f.service() });
    const request = (method = "GET", body?: unknown, headers = {}) => new Request("https://app.example/v1/webhooks", {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: { "Content-Type": "application/json", ...headers },
    });
    assert.equal((await api(request())).status, 401);
    identity = { id: 1 };
    assert.equal((await api(request("POST", {}, { Origin: "https://other.example" }))).status, 403);
    assert.equal((await api(request("POST", {}, { "sec-fetch-site": "cross-site" }))).status, 403);
    for (const body of [null, [], {}, { url: "https://receiver.example", events: [] }, { url: "https://receiver.example", enabled: "true" },
      { url: "https://receiver.example", events: ["bogus"] }, { url: "https://receiver.example", user_id: 2 }]) {
      assert.equal((await api(request("POST", body))).status, 400);
    }
    const created = await api(request("POST", { url: "https://receiver.example" }));
    assert.equal(created.status, 201);
    const hook = await created.json(); assert.ok(hook.secret);
    assert.doesNotMatch(await (await api(request())).text(), /secret|cipher/);
    const update = await api(request("PATCH", { events: ["phone.stopped"] }), hook.id);
    assert.equal(update.status, 200); assert.equal((await update.json()).secret, undefined);
    const rolled = await (await api(request("PATCH", { roll_secret: true }), hook.id)).json();
    assert.notEqual(rolled.secret, hook.secret);
    assert.equal((await api(request("POST"), hook.id, "test")).status, 202);
    const delivery = (await (await api(request(), hook.id, "deliveries")).json())[0];
    identity = { id: 2 };
    for (const response of [await api(request("DELETE"), hook.id), await api(request(), hook.id, "deliveries"),
      await api(request("POST"), hook.id, "test"), await api(request("POST"), hook.id, "deliveries", delivery.id),
      await api(request("PATCH", { roll_secret: true }), hook.id)]) assert.equal(response.status, 400);
    assert.equal(f.service().list(1).length, 1);
  } finally { f.close(); }
});

test("local receiver verifies wire signatures, refuses redirects, and aborts a stalled response after 10 seconds", async () => {
  const f = fixture();
  let received = 0;
  let redirected = 0;
  let secret = "";
  let valid = false;
  const server = createServer(async (request, response) => {
    if (request.url === "/redirected") redirected++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received++;
    const body = Buffer.concat(chunks).toString("utf8");
    valid = verifyWebhook(secret, body, String(request.headers["phonelink-signature"]), f.clock)
      && request.headers["phonelink-event"] === "webhook.test" && String(request.headers["phonelink-delivery"]).startsWith("dlv_");
    if (request.url === "/timeout") return;
    response.writeHead(302, { Location: "/redirected" }); response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const resolve: ResolveHost = async () => [{ address: "127.0.0.1", family: 4 }];
    const service = f.service(resolve, "http://localhost:4321");
    const hook = await service.create(1, { url: `http://localhost:${address.port}/hook` }); secret = hook.secret;
    service.test(1, hook.id);
    await f.outbox(undefined, resolve, "http://localhost:4321")();
    assert.equal(received, 1); assert.equal(redirected, 0); assert.ok(valid);
    assert.equal(service.deliveries(1, hook.id)[0]?.status, 302);
    assert.equal(service.deliveries(1, hook.id)[0]?.state, "pending");
    const stalled = await service.create(1, { url: `http://localhost:${address.port}/timeout` }); secret = stalled.secret;
    service.test(1, stalled.id);
    const started = performance.now();
    await f.outbox(undefined, resolve, "http://localhost:4321")();
    assert.ok(performance.now() - started >= 9_500, "The request should receive its full 10-second deadline");
    assert.equal(service.deliveries(1, stalled.id)[0]?.status, null);
    assert.equal(service.deliveries(1, stalled.id)[0]?.state, "pending");
    assert.equal(service.deliveries(1, stalled.id)[0]?.attempt, 1);
  } finally { server.closeAllConnections(); server.close(); await once(server, "close"); f.close(); }
});

test("poller flushes endpoints without phones and prevents overlapping ticks", async () => {
  const f = fixture();
  try {
    const hook = await f.service().create(1, { url: "https://receiver.example" });
    f.service().test(1, hook.id);
    let calls = 0;
    const flush = f.outbox(async () => { calls++; return 200; });
    const tick = createStatePoller({ database: f.database, clock: f.clock, sync: async () => assert.fail("No phone sync expected"), deliver: flush });
    await Promise.all([tick(), tick(), tick()]);
    assert.equal(calls, 1); assert.equal(f.service().deliveries(1, hook.id)[0]?.state, "ok");
  } finally { f.close(); }
});

test("phone operations enqueue actual lifecycle events once, preserving stop reasons and GitHub failure messages", async () => {
  const f = fixture();
  try {
    const hook = await f.service().create(1, { url: "https://receiver.example" });
    const machine = { name: "fixture-machine", display_name: "2 cores", cpus: 2, memory_in_bytes: 1024 };
    let space: Codespace = { id: 101, name: "owned-space", state: "Provisioning", machine };
    let refuseStart = false;
    let deleted = false;
    const github = createGitHubClient({ database: f.database, accessToken: async () => "synthetic-token", fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/machines")) return Response.json({ machines: [machine] });
      if (path.endsWith("/start")) {
        if (refuseStart) return Response.json({ message: "GitHub refused synthetic-token because hours are exhausted." }, { status: 403 });
        space = { ...space, state: "Starting" }; return Response.json(space);
      }
      if (path.endsWith("/stop")) return new Response(null, { status: 202 });
      if (init?.method === "POST") return Response.json(space);
      return path === "/user/codespaces" ? Response.json({ codespaces: deleted ? [] : [space,
        { id: 999, name: "foreign-space", state: "Shutdown" }] }) : Response.json(space);
    } });
    const service = createPhoneService({ database: f.database, github, encrypt: f.encrypt, clock: f.clock });
    const id = await service.create(1, { repository: "fixture/template", repositoryId: 1, idleTimeoutMin: 30, devcontainerPath: ".devcontainer/devcontainer.json" });
    const events = () => f.database.prepare("SELECT type, body FROM webhook_deliveries WHERE webhook_id = ? ORDER BY rowid").all(hook.id)
      .map(row => ({ type: row.type, ...JSON.parse(String(row.body)) }));
    assert.deepEqual(events().map(event => event.type), ["phone.created"]);
    space.state = "Available"; await service.sync(1);
    assert.equal(events().some(event => event.type === "phone.ready"), false, "Available alone does not prove adb is ready");
    await service.stop(1, id); space.state = "Shutdown"; await service.sync(1); await service.sync(1);
    assert.equal(events().filter(event => event.type === "phone.stopped").length, 1);
    assert.equal(events().at(-1)?.data.reason, "user");
    await service.start(1, id); await service.start(1, id);
    assert.equal(events().filter(event => event.type === "phone.starting").length, 1);
    space.state = "Available"; await service.sync(1);
    await service.autoStop(1, id); space.state = "Shutdown"; await service.sync(1);
    // The poller sends one hours.auto_stopped for each auto-stop run (see poller tests).
    assert.equal(events().filter(event => event.type === "hours.auto_stopped").length, 0);
    assert.equal(events().at(-1)?.data.reason, "hours_budget");
    f.advance(60_000); refuseStart = true;
    await assert.rejects(service.start(1, id));
    assert.equal(events().at(-1)?.type, "phone.error");
    assert.match(events().at(-1)?.data.message, /hours are exhausted/);
    assert.doesNotMatch(events().at(-1)?.data.message, /synthetic-token/);
    refuseStart = false; f.advance(60_000);
    await service.keep(1, id); f.advance(60_000); space.state = "Available"; await service.sync(1);
    space.state = "Shutdown"; await service.sync(1);
    assert.equal(events().filter(event => event.type === "phone.kept").length, 1);
    assert.equal(events().filter(event => event.type === "phone.stopped").at(-1)?.data.reason, "retention");
    deleted = true; await service.sync(1);
    assert.equal(events().at(-1)?.type, "phone.deleted");
    assert.ok(events().every(event => event.data.phone?.name !== "foreign-space"));
  } finally { f.close(); }
});

test("synchronous tests sign and persist the real result, isolate the delivery, and rate limit across requests", async () => {
  const f = fixture();
  try {
    let secret = "";
    let sends = 0;
    const service = f.service(publicDns, "https://phonelink.example", async (_target, body, headers, signal) => {
      sends++;
      assert.equal(signal.aborted, false);
      assert.equal(headers["phonelink-event"], "webhook.test");
      assert.ok(verifyWebhook(secret, body, headers["phonelink-signature"]!, f.clock));
      f.advance(142);
      return 200;
    });
    const hook = await service.create(1, { url: "https://receiver.example" }); secret = hook.secret;
    const other = await service.create(1, { url: "https://other.example" });
    service.test(1, other.id);
    const api = createWebhookApi({ user: async () => ({ id: 1 }), service });
    const request = () => new Request(`https://app.example/v1/webhooks/${hook.id}/test?wait=1`, { method: "POST" });
    const response = await api(request(), hook.id, "test");
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.state, "ok"); assert.equal(result.status, 200); assert.equal(result.duration_ms, 142);
    assert.equal(service.deliveries(1, hook.id)[0]?.attempt, 1);
    assert.equal(service.deliveries(1, other.id)[0]?.attempt, 0);
    assert.equal((await api(request(), hook.id, "test")).status, 429);
    assert.throws(() => f.service().test(1, hook.id), /Wait 5 seconds/);
    assert.equal(sends, 1);
    f.advance(5000);
    assert.equal((await api(request(), hook.id, "test")).status, 200);
    assert.equal(sends, 2);
    secret = other.secret;
    const independent = await api(request(), other.id, "test");
    assert.equal(independent.status, 200);
    assert.equal((await independent.json()).state, "ok");
    await assert.rejects(service.testNow(2, hook.id), /not found/);
    await service.update(1, hook.id, { enabled: false });
    await assert.rejects(service.testNow(1, hook.id), /Re-enable/);
  } finally { f.close(); }
});

test("synchronous test reports HTTP and network failures and refuses DNS rebinding before sending", async () => {
  const f = fixture();
  try {
    const hook = await f.service().create(1, { url: "https://receiver.example" });
    let sends = 0;
    for (const send of [async () => { sends++; return 503; }, async () => { sends++; throw new Error("private provider details"); }]) {
      const result = await f.service(publicDns, "https://phonelink.example", send).testNow(1, hook.id);
      assert.equal(result?.state, "pending");
      assert.equal(result?.status, sends === 1 ? 503 : null);
      assert.equal(f.service().deliveries(1, hook.id)[0]?.attempt, 1);
      f.advance(5000);
    }
    const result = await f.service(async () => [{ address: "127.0.0.1", family: 4 }], "https://phonelink.example",
      async () => { sends++; return 200; }).testNow(1, hook.id);
    assert.equal(sends, 2); assert.equal(result?.status, null);
    assert.doesNotMatch(JSON.stringify(result), /private|provider|127\.0\.0\.1/);
  } finally { f.close(); }
});

test("a synchronous test and a concurrent outbox tick attempt a delivery only once", async () => {
  const f = fixture();
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    let sends = 0;
    const service = f.service(publicDns, "https://phonelink.example", async () => { sends++; await gate; return 204; });
    const hook = await service.create(1, { url: "https://receiver.example" });
    const testing = service.testNow(1, hook.id);
    await f.outbox(async () => { sends++; return 200; })();
    release();
    const result = await testing;
    assert.equal(sends, 1); assert.equal(result?.status, 204);
    assert.equal(service.deliveries(1, hook.id)[0]?.attempt, 1);
  } finally { release(); f.close(); }
});
