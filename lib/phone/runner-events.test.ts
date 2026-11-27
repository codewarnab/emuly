import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
import { handleRunnerEvent, runnerEventKey, runnerEventsFile, runnerEventsUrl } from "./runner-events.ts";
import { finishBoot } from "./boot-finish.ts";
import { createEvents, parseEventsFile, signEvent } from "../../phone/runner/events.mjs";

const SECRET = "s".repeat(48);
const OLD_SECRET = "o".repeat(48);
const ATTEMPT = "2026-11-20T15:00:00.000Z";
const NOW = Date.parse("2026-11-20T15:01:30.000Z");

async function database(androidState = "booting", attempt = ATTEMPT) {
  const client = createClient({ url: ":memory:" });
  await migrateHosted(client);
  await client.execute("INSERT INTO users (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at) VALUES (1, 11, 'a', X'00', 'codespace', '2026-01-01', '2026-01-01')");
  await client.execute({ sql: `INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, state, android_state, android_started_at,
    created_at, idle_timeout_min) VALUES ('p1', 1, 'space-a', 'r/t', 'm', 'running', ?, ?, '2026-11-01', 30)`, args: [androidState, attempt] });
  return client;
}

function request(body: unknown, { codespace = "space-a", secret = SECRET } = {}) {
  const text = JSON.stringify(body);
  return new Request("https://emuly.example/api/runner/events", { method: "POST", body: text,
    headers: { "x-emuly-phone": codespace, "x-emuly-signature": signEvent(runnerEventKey(codespace, secret), text) } });
}

function deps(client: ReturnType<typeof createClient>, { booted = true, checks = [] as string[] } = {}) {
  return { database: client, secrets: [SECRET, OLD_SECRET], baseUrl: "https://emuly.example", clock: () => NOW,
    confirmBooted: async (_userId: number, id: string) => { checks.push(id); return booted; } };
}

const phone = async (client: ReturnType<typeof createClient>) =>
  (await client.execute("SELECT android_state, last_activity_at, android_ready_at FROM phones WHERE id = 'p1'")).rows[0]!;

test("boot.ready from the phone, for the current attempt, marks it ready after /health confirms", async () => {
  const client = await database();
  const checks: string[] = [];
  const response = await handleRunnerEvent(request({ type: "boot.ready", attempt: ATTEMPT }), deps(client, { checks }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: "applied", events_url: "https://emuly.example/api/runner/events" });
  assert.deepEqual(checks, ["p1"]);
  const row = await phone(client);
  assert.equal(row.android_state, "ready");
  assert.equal(row.last_activity_at, new Date(NOW).toISOString(), "Emuly's own clock starts the idle clock");
  assert.equal(row.android_ready_at, new Date(NOW).toISOString(), "ready_at records when the boot ended");
  const step = (await client.execute("SELECT message FROM events WHERE phone_id = 'p1'")).rows[0]!;
  assert.equal(step.message, "Android ready (took 90 s)");
});

test("a false boot.ready: /health says Android is not up, so nothing changes", async () => {
  const client = await database();
  const response = await handleRunnerEvent(request({ type: "boot.ready", attempt: ATTEMPT }), deps(client, { booted: false }));
  assert.equal((await response.json()).result, "unconfirmed");
  assert.equal((await phone(client)).android_state, "booting");
});

test("a late boot.failed from an old attempt does not touch the new boot", async () => {
  const client = await database("ready", "2026-11-20T15:05:00.000Z");
  const response = await handleRunnerEvent(request({ type: "boot.failed", attempt: ATTEMPT }), deps(client));
  assert.equal((await response.json()).result, "stale");
  assert.equal((await phone(client)).android_state, "ready");
});

test("an event before Emuly wrote booting for this attempt is dropped; the sync loop is the backstop", async () => {
  const client = await database("idle", "2026-11-20T14:00:00.000Z");
  const response = await handleRunnerEvent(request({ type: "boot.ready", attempt: ATTEMPT }), deps(client));
  assert.equal((await response.json()).result, "stale");
  assert.equal((await phone(client)).android_state, "idle");
});

test("a second copy of the same event changes nothing", async () => {
  const client = await database();
  const checks: string[] = [];
  await handleRunnerEvent(request({ type: "boot.ready", attempt: ATTEMPT }), deps(client, { checks }));
  const again = await handleRunnerEvent(request({ type: "boot.ready", attempt: ATTEMPT }), deps(client, { checks }));
  assert.equal((await again.json()).result, "already");
  assert.equal(checks.length, 1, "no second /health check");
  assert.equal((await client.execute("SELECT COUNT(*) AS n FROM events")).rows[0]!.n, 1, "one step event");
});

test("boot.failed for the current attempt marks the boot failed", async () => {
  const client = await database();
  const response = await handleRunnerEvent(request({ type: "boot.failed", attempt: ATTEMPT }), deps(client));
  assert.equal((await response.json()).result, "applied");
  const row = await phone(client);
  assert.equal(row.android_state, "failed");
  assert.equal(row.android_ready_at, null, "a failed boot does not set ready_at");
});

test("push and the boot call share one finish: the later one sees 'already', not a failure", async () => {
  const client = await database();
  await handleRunnerEvent(request({ type: "boot.ready", attempt: ATTEMPT }), deps(client));
  assert.equal(await finishBoot(client, { userId: 1, id: "p1", attempt: ATTEMPT, booted: true }, NOW), "already");
});

test("signature: another phone's key, a changed body or a bad header is refused; the old server key still works", async () => {
  const client = await database();
  const wrongPhone = request({ type: "boot.ready", attempt: ATTEMPT }, { codespace: "space-b" });
  wrongPhone.headers.set("x-emuly-phone", "space-a");
  assert.equal((await handleRunnerEvent(wrongPhone, deps(client))).status, 401);
  const changed = new Request(request({}).url, { method: "POST", body: JSON.stringify({ type: "boot.ready", attempt: ATTEMPT }),
    headers: { "x-emuly-phone": "space-a", "x-emuly-signature": signEvent(runnerEventKey("space-a", SECRET), "{}") } });
  assert.equal((await handleRunnerEvent(changed, deps(client))).status, 401);
  assert.equal((await handleRunnerEvent(request({ type: "boot.ready", attempt: ATTEMPT }, { codespace: "../x" }), deps(client))).status, 400);
  assert.equal((await handleRunnerEvent(request({ type: "boot.other", attempt: ATTEMPT }), deps(client))).status, 400);
  const rotated = await handleRunnerEvent(request({ type: "boot.ready", attempt: ATTEMPT }, { secret: OLD_SECRET }), deps(client));
  assert.equal((await rotated.json()).result, "applied");
});

test("the events URL comes from the base URL, so a new domain needs only a new EMULY_BASE_URL", () => {
  assert.equal(runnerEventsUrl("https://emuly.xyz/"), "https://emuly.xyz/api/runner/events");
  assert.equal(runnerEventsUrl("https://phones.example.com"), "https://phones.example.com/api/runner/events");
  assert.equal(runnerEventsUrl("http://localhost:4321"), undefined, "a codespace cannot reach a laptop");
  assert.equal(runnerEventsUrl(undefined), undefined);
  const file = runnerEventsFile("space-a", { baseUrl: "https://phones.example.com", secret: SECRET })!;
  assert.deepEqual(parseEventsFile(file), { url: "https://phones.example.com/api/runner/events", key: runnerEventKey("space-a", SECRET), codespace: "space-a" });
  assert.equal(runnerEventsFile("space-a", { baseUrl: "https://x.example", secret: undefined }), undefined);
});

test("runner: it retries a network fault, follows a new events URL from the answer, and stops on a refusal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "emuly-events-"));
  const file = join(dir, ".events");
  writeFileSync(file, runnerEventsFile("space-a", { baseUrl: "https://old.example", secret: SECRET })!);
  const calls: { url: string; body: string; signature: string }[] = [];
  let failures = 1;
  const events = createEvents({ file, pause: async () => {}, fetcher: (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body), signature: (init.headers as Record<string, string>)["x-emuly-signature"]! });
    if (failures-- > 0) throw new Error("offline");
    return Response.json({ result: "applied", events_url: "https://new.example/api/runner/events" });
  }) as typeof fetch });
  assert.equal(await events.send("boot.ready", ATTEMPT), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.signature, signEvent(runnerEventKey("space-a", SECRET), calls[1]!.body));
  assert.equal(readFileSync(file, "utf8").split("\n")[0], "https://new.example/api/runner/events", "the runner saves the new URL");
  await events.send("boot.ready", ATTEMPT);
  assert.equal(calls[2]!.url, "https://new.example/api/runner/events");

  let refused = 0;
  const strict = createEvents({ file, pause: async () => {}, fetcher: (async () => { refused++; return Response.json({ error: "bad_signature" }, { status: 401 }); }) as unknown as typeof fetch });
  assert.equal(await strict.send("boot.ready", ATTEMPT), false);
  assert.equal(refused, 1, "a 401 is final; no retry");
  const off = createEvents({ file: join(dir, "missing"), fetcher: (async () => { throw new Error("must not call"); }) as typeof fetch });
  assert.equal(await off.send("boot.ready", ATTEMPT), false, "no .events file: push is off");
});
