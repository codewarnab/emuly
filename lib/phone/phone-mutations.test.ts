import { pathToFileURL } from "node:url";
import { createClient } from "../data/async-database.ts";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../data/database.ts";
import { createGitHubClient, GitHubError, PHONE_MACHINE, type Codespace } from "../github/github.ts";
import { createPhoneService, PhoneInputError, UNCONFIRMED_CREATION_EXPIRY_MS } from "./phone-mutations.ts";
import { RateLimitError } from "../data/rate-limit.ts";
import { updateSettings, userSettings } from "../data/settings.ts";
import { readUsage, saveAllowance } from "../data/usage.ts";
import { createPhoneApi } from "./phone-api.ts";
import { createStatePoller } from "./poller.ts";
import { seal, open, contexts } from "../auth/crypto-core.ts";

const key = Buffer.alloc(32, 7).toString("base64");
const input = { repository: "fixture/template", repositoryId: 123, idleTimeoutMin: 30,
  devcontainerPath: ".devcontainer/devcontainer.json" };
const machine = { name: "fixture-machine", display_name: "2 CPU", cpus: 2, memory_in_bytes: 8 * 1024 ** 3 };
const space = (name: string, state = "Shutdown"): Codespace => ({ id: 41, name, state, machine });

const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(fetcher: typeof fetch) {
  const directory = mkdtempSync(join(tmpdir(), "emuly-m0-"));
  const database = openDatabase(join(directory, "test.db"));
  const asyncDatabase = createClient({ url: pathToFileURL(join(directory, "test.db")).href });
  for (const id of [1, 2]) database.prepare(`INSERT INTO users
    (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, 'codespace', '2026-11-01', '2026-11-01')`).run(id, id, `fixture-${id}`, Buffer.from("encrypted"));
  let time = Date.parse("2026-11-07T00:00:00.000Z");
  const github = createGitHubClient({ database: asyncDatabase, accessToken: async id => `synthetic-${id}`, fetch: fetcher });
  const service = createPhoneService({ database: asyncDatabase, github, encrypt: (plain, context) => seal(plain, key, context), clock: () => time });
  return {
    asyncDatabase, database, github, service, advance: (ms: number) => { time += ms; },
    add(id: string, user = 1, name = `generated-${id}`) {
      database.prepare(`INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, state,
        created_at, runner_secret) VALUES (?, ?, ?, 'fixture/template', 'fixture-machine', 'stopped', '2026-11-01', ?)`)
        .run(id, user, name, seal("synthetic-runner-secret", key, contexts.runnerSecret(id)));
    },
    async close() {
      asyncDatabase.close();
      database.close();
      // Native SQLite statements can retain Windows file handles until collection.
      globalThis.gc?.();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

test("GitHub lists only database-owned identifiers across pages and refuses foreign phone IDs before HTTP", async () => {
  const calls: string[] = [];
  const f = fixture(async (url, init) => {
    calls.push(String(url));
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-1");
    if (String(url).endsWith("page=1")) return Response.json({ codespaces: [space("foreign"), space("emuly-unregistered")] },
      { headers: { link: '<https://api.github.com/user/codespaces?per_page=100&page=2>; rel="next"' } });
    if (String(url).endsWith("page=2")) return Response.json({ codespaces: [space("automatic-spoon-owned")] });
    assert.equal(String(url), "https://api.github.com/user/codespaces/automatic-spoon-owned");
    return Response.json(space("automatic-spoon-owned"));
  });
  try {
    f.add("phone-aaaa", 1, "automatic-spoon-owned");
    f.add("phone-bbbb", 2, "foreign");
    assert.deepEqual((await f.github.listCodespaces(1)).map(row => row.name), ["automatic-spoon-owned"]);
    assert.equal((await f.github.getCodespace(1, "phone-aaaa")).state, "Shutdown");
    const before = calls.length;
    await assert.rejects(f.github.getCodespace(1, "phone-bbbb"), /Phone not found/);
    await assert.rejects(f.github.startCodespace(1, "phone-bbbb"), /Phone not found/);
    await assert.rejects(f.github.stopCodespace(1, "phone-bbbb"), /Phone not found/);
    await assert.rejects(f.service.stop(1, "automatic-spoon-owned"), /Invalid phone ID/);
    assert.equal(calls.length, before);
  } finally { await f.close(); }
});

test("create records intent before HTTP, chooses an available machine, sends timeout and retention, and permits three phones", async () => {
  let creates = 0;
  const bodies: Record<string, unknown>[] = [];
  const f = fixture(async (url, init) => {
    if (String(url).endsWith("/machines")) return Response.json({ machines: [machine] });
    assert.equal(url, "https://api.github.com/user/codespaces");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body));
    const row = f.database.prepare("SELECT state, codespace_name FROM phones WHERE id = ?").get(body.display_name);
    assert.equal(row?.state, "pending");
    assert.equal(row?.codespace_name, `pending:${body.display_name}`);
    assert.equal(f.database.prepare("SELECT outcome FROM phone_creations WHERE phone_id = ?").get(body.display_name)?.outcome,
      "unconfirmed");
    assert.equal(f.database.prepare("SELECT kind FROM events WHERE phone_id = ? ORDER BY id LIMIT 1").get(body.display_name)?.kind, "action");
    bodies.push(body);
    return Response.json({ ...space(`github-generated-${++creates}`, "Provisioning"), id: creates });
  });
  try {
    for (let n = 0; n < 3; n++) {
      const id = await f.service.create(1, { ...input, idleTimeoutMin: n === 1 ? 240 : 30 });
      const row = f.database.prepare("SELECT * FROM phones WHERE id = ?").get(id)!;
      assert.equal(row.state, "booting");
      assert.equal(row.codespace_name, `github-generated-${n + 1}`);
      assert.equal(row.machine, "fixture-machine");
      assert.equal(row.cores, 2);
      assert.equal(row.idle_timeout_min, n === 1 ? 240 : 30);
      assert.equal(row.retention_min, 43200);
      const secret = open(row.runner_secret as Uint8Array, key, contexts.runnerSecret(id));
      assert.equal(secret.length, 43);
      assert.ok(!JSON.stringify(f.database.prepare("SELECT message FROM events").all()).includes(secret));
      f.advance(60_000);
    }
    assert.equal(creates, 3);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM phones").get()?.n, 3);
    assert.deepEqual(bodies.map(body => [body.repository_id, body.machine, body.idle_timeout_minutes, body.retention_period_minutes]),
      [[123, "fixture-machine", 30, 43200], [123, "fixture-machine", 240, 43200], [123, "fixture-machine", 30, 43200]]);
    assert.ok(bodies.every(body => body.devcontainer_path === input.devcontainerPath));
  } finally { await f.close(); }
});

test("GitHub refusal preserves its message, records the failure, and does not retry creation", async () => {
  let posts = 0;
  const f = fixture(async (url) => {
    if (String(url).endsWith("/machines")) return Response.json({ machines: [machine] });
    posts++;
    return Response.json({ message: "Your Codespaces spending limit has been reached." }, { status: 403 });
  });
  try {
    await assert.rejects(f.service.create(1, input), error => error instanceof GitHubError && error.status === 403
      && error.message === "Your Codespaces spending limit has been reached.");
    assert.equal(posts, 1);
    const phone = f.database.prepare("SELECT state, state_detail FROM phones").get()!;
    assert.equal(phone.state, "error");
    assert.equal(phone.state_detail, "Your Codespaces spending limit has been reached.");
    assert.equal(f.database.prepare("SELECT outcome FROM phone_creations").get()?.outcome, "failed");
    assert.deepEqual(f.database.prepare("SELECT kind FROM events ORDER BY id").all().map(row => row.kind), ["action", "error"]);
    await assert.rejects(f.service.create(1, input), RateLimitError);
    assert.equal(posts, 1);
    f.advance(60_000);
    await assert.rejects(f.service.create(1, input), GitHubError);
    assert.equal(posts, 2);
  } finally { await f.close(); }
});

test("creation reserves its operation before machine lookup and blocks overlapping attempts", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let posts = 0;
  const f = fixture(async (url, init) => {
    if (String(url).endsWith("/machines")) {
      entered.resolve();
      await release.promise;
      return Response.json({ machines: [] });
    }
    if (init?.method === "POST") posts++;
    return Response.json({ codespaces: [] });
  });
  let creating: Promise<void> | undefined;
  try {
    creating = assert.rejects(f.service.create(1, input), /machine is unavailable/);
    await entered.promise;
    f.advance(60_000);
    await assert.rejects(f.service.create(1, input), /unconfirmed|already in progress/);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM phones").get()?.n, 1);
    release.resolve();
    await creating;
    assert.equal(f.database.prepare("SELECT outcome FROM phone_creations").get()?.outcome, "failed");
    assert.equal(posts, 0);
  } finally { release.resolve(); await creating; await f.close(); }
});

test("interrupted creation survives a restart, blocks replacement, and recovers the submitted display name across pages", async () => {
  let displayName = "";
  let posts = 0;
  let visible = false;
  let listingFails = false;
  const stopped: string[] = [];
  const f = fixture(async (url, init) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith("/machines")) return Response.json({ machines: [machine] });
    if (target.pathname.endsWith("/stop")) {
      stopped.push(target.pathname);
      return new Response(null, { status: 202 });
    }
    if (init?.method === "POST") {
      posts++;
      displayName = JSON.parse(String(init.body)).display_name;
      throw new Error("Response timed out after GitHub created the Codespace");
    }
    const recovered = { ...space("github-recovered", "Available"), display_name: displayName };
    if (target.pathname !== "/user/codespaces") return Response.json(recovered);
    if (listingFails) return Response.json({ message: "Try later" }, { status: 503 });
    if (target.searchParams.get("page") === "1") {
      return Response.json({ codespaces: [{ ...space("foreign"), display_name: "phone-bbbb" }] },
        { headers: { link: '<https://api.github.com/user/codespaces?per_page=100&page=2>; rel="next"' } });
    }
    return Response.json({ codespaces: visible ? [recovered] : [] });
  });
  try {
    await assert.rejects(f.service.create(1, input), /Response timed out/);
    const before = f.database.prepare("SELECT id, runner_secret FROM phones").get()!;
    assert.equal(f.database.prepare("SELECT outcome FROM phone_creations").get()?.outcome, "unconfirmed");
    f.add("phone-bbbb", 2, "pending:phone-bbbb");
    f.database.prepare(`INSERT INTO phone_creations VALUES ('phone-bbbb', 'phone-bbbb', 'unconfirmed', '2026-11-07')`).run();
    f.advance(60_000);
    const restarted = createPhoneService({ database: f.asyncDatabase, github: f.github, encrypt: (value, context) => seal(value, key, context),
      clock: () => Date.parse("2026-11-07T00:01:00Z") });
    await assert.rejects(restarted.create(1, input), /unconfirmed/);
    assert.equal(posts, 1);
    assert.equal(f.database.prepare("SELECT state FROM phones WHERE id = ?").get(before.id)?.state, "error");
    listingFails = true;
    await assert.rejects(restarted.create(1, input), GitHubError);
    assert.equal(posts, 1);
    listingFails = false;
    visible = true;
    await restarted.sync(1);
    const row = f.database.prepare("SELECT * FROM phones WHERE id = ?").get(before.id)!;
    assert.equal(row.codespace_name, "github-recovered");
    assert.equal(row.codespace_id, "41");
    assert.equal(row.state, "booting");
    assert.deepEqual(row.runner_secret, before.runner_secret);
    assert.equal(f.database.prepare("SELECT outcome FROM phone_creations WHERE phone_id = ?").get(before.id)?.outcome, "confirmed");
    assert.equal(f.database.prepare("SELECT outcome FROM phone_creations WHERE phone_id = 'phone-bbbb'").get()?.outcome, "unconfirmed");
    await restarted.stop(1, String(before.id));
    assert.deepEqual(stopped, ["/user/codespaces/github-recovered/stop"]);
    assert.equal(posts, 1);
  } finally { await f.close(); }
});

test("sync recovers a pending creation after a server error but refuses ambiguous display names", async () => {
  let displayName = "";
  let ambiguous = true;
  const f = fixture(async (url, init) => {
    if (String(url).endsWith("/machines")) return Response.json({ machines: [machine] });
    if (init?.method === "POST") {
      displayName = JSON.parse(String(init.body)).display_name;
      return Response.json({ message: "Gateway timeout" }, { status: 504 });
    }
    return Response.json({ codespaces: (ambiguous ? ["one", "two"] : ["one"])
      .map(name => ({ ...space(name), display_name: displayName })) });
  });
  try {
    await assert.rejects(f.service.create(1, input), GitHubError);
    await f.service.sync(1);
    assert.equal(f.database.prepare("SELECT outcome FROM phone_creations").get()?.outcome, "unconfirmed");
    ambiguous = false;
    await f.service.sync(1);
    assert.equal(f.database.prepare("SELECT codespace_name FROM phones").get()?.codespace_name, "one");
    assert.equal(f.database.prepare("SELECT state FROM phones").get()?.state, "stopped");
    assert.equal(f.database.prepare("SELECT outcome FROM phone_creations").get()?.outcome, "confirmed");
  } finally { await f.close(); }
});

test("a recovered creation lets the requested new phone be created", async () => {
  let posts = 0;
  let displayName = "";
  const f = fixture(async (url, init) => {
    if (String(url).endsWith("/machines")) return Response.json({ machines: [machine] });
    if (init?.method === "POST") {
      posts++;
      if (posts === 1) { displayName = JSON.parse(String(init.body)).display_name; throw new Error("timed out"); }
      return Response.json(space("second"));
    }
    return Response.json({ codespaces: [{ ...space("first"), display_name: displayName }] });
  });
  try {
    await assert.rejects(f.service.create(1, input), /timed out/);
    const first = String(f.database.prepare("SELECT id FROM phones").get()!.id);
    f.advance(60_000);
    const second = await f.service.create(1, input);
    assert.notEqual(second, first);
    assert.equal(posts, 2);
    assert.equal(f.database.prepare("SELECT codespace_name FROM phones WHERE id = ?").get(first)?.codespace_name, "first");
  } finally { await f.close(); }
});

test("an unconfirmed creation with no Codespace on GitHub expires and stops blocking creation", async () => {
  let posts = 0;
  const f = fixture(async (url, init) => {
    if (String(url).endsWith("/machines")) return Response.json({ machines: [machine] });
    if (init?.method === "POST") {
      posts++;
      if (posts === 1) throw new Error("timed out");
      return Response.json(space("second"));
    }
    return Response.json({ codespaces: [] });
  });
  try {
    await assert.rejects(f.service.create(1, input), /timed out/);
    f.advance(60_000);
    await assert.rejects(f.service.create(1, input), /unconfirmed/);
    f.advance(UNCONFIRMED_CREATION_EXPIRY_MS);
    await f.service.create(1, input);
    assert.equal(posts, 2);
    assert.deepEqual(f.database.prepare("SELECT outcome FROM phone_creations ORDER BY requested_at").all().map(r => r.outcome),
      ["failed", "confirmed"]);
  } finally { await f.close(); }
});

test("start and stop are idempotent, reconcile asynchronous state, and preserve the existing codespace and secret", async () => {
  let current = space("automatic-owned");
  const writes: string[] = [];
  const f = fixture(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/start")) { writes.push("start"); current = space(current.name, "Starting"); return Response.json(current); }
    if (path.endsWith("/stop")) { writes.push("stop"); return new Response(null, { status: 202 }); }
    assert.equal(init?.method, "GET");
    return path === "/user/codespaces" ? Response.json({ codespaces: [current] }) : Response.json(current);
  });
  try {
    f.add("phone-aaaa", 1, current.name);
    const before = f.database.prepare("SELECT codespace_name, runner_secret FROM phones").get();
    await f.service.start(1, "phone-aaaa");
    await f.service.start(1, "phone-aaaa");
    assert.deepEqual(writes, ["start"]);
    assert.equal(f.database.prepare("SELECT state FROM phones").get()?.state, "booting");
    current = space(current.name, "Available");
    await f.service.sync(1);
    assert.match(String(f.database.prepare("SELECT state_detail FROM phones").get()?.state_detail), /not connected yet/);
    await f.service.start(1, "phone-aaaa");
    await f.service.stop(1, "phone-aaaa");
    assert.equal(f.database.prepare("SELECT state FROM phones").get()?.state, "stopping");
    assert.equal(f.database.prepare("SELECT last_stopped_at FROM phones").get()?.last_stopped_at, null);
    f.advance(15_000);
    current = { ...space(current.name), retention_expires_at: "2026-11-14T01:00:00.000Z" };
    await f.service.sync(1);
    await f.service.stop(1, "phone-aaaa");
    assert.deepEqual(writes, ["start", "stop"]);
    const row = f.database.prepare("SELECT state, last_stopped_at, retention_at FROM phones").get()!;
    assert.equal(row.state, "stopped");
    assert.equal(row.last_stopped_at, "2026-11-07T00:00:15.000Z");
    assert.equal(row.retention_at, "2026-11-14T01:00:00.000Z");
    const usage = await readUsage(f.asyncDatabase, 1, () => Date.parse("2026-11-07T01:00:00Z"));
    assert.equal(usage.used_core_hours, 2 * 15 / 3600);
    assert.deepEqual(usage.running, []);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM runs").get()?.n, 1);
    assert.deepEqual(f.database.prepare("SELECT codespace_name, runner_secret FROM phones").get(), before);
  } finally { await f.close(); }
});

test("rate limits share an account's mutation budget, isolate accounts, survive service recreation, and expire at 60 seconds", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url) => {
    calls++;
    if (String(url).endsWith("/machines")) return Response.json({ machines: [machine] });
    if (String(url).endsWith("/user/codespaces")) return Response.json(space(`created-${calls}`, "Creating"));
    return Response.json(space("generated-phone-aaaa", "Available"));
  };
  const f = fixture(fetcher);
  try {
    f.add("phone-aaaa");
    f.add("phone-bbbb", 2);
    await f.service.create(1, input);
    const before = calls;
    await assert.rejects(f.service.create(1, input), error => error instanceof RateLimitError && error.retryAfter === 60);
    assert.equal(calls, before);
    for (let n = 0; n < 5; n++) await f.service.start(1, "phone-aaaa");
    const full = calls;
    await assert.rejects(f.service.start(1, "phone-aaaa"), RateLimitError);
    assert.equal(calls, full);
    await f.service.start(2, "phone-bbbb");
    const other = createPhoneService({ database: f.asyncDatabase, github: f.github, encrypt: (plain, context) => seal(plain, key, context),
      clock: () => Date.parse("2026-11-07T00:00:59.999Z") });
    await assert.rejects(other.start(1, "phone-aaaa"), RateLimitError);
    f.advance(60_000);
    await f.service.create(1, input);
    await f.service.start(1, "phone-aaaa");
  } finally { await f.close(); }
});

test("invalid creation inputs and blocked users cannot call GitHub", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error("unexpected HTTP"); });
  try {
    await assert.rejects(f.service.create(1, { ...input, idleTimeoutMin: 3 }), PhoneInputError);
    await assert.rejects(f.service.create(1, { ...input, repositoryId: -1 }), PhoneInputError);
    f.database.prepare("UPDATE users SET blocked = 1 WHERE id = 1").run();
    await assert.rejects(f.service.create(1, input), /Sign in again/);
    assert.equal(calls, 0);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM phones").get()?.n, 0);
  } finally { await f.close(); }
});

test("a failed stop preserves the phone state and records GitHub's message without credentials", async () => {
  const credential = `gho_${"x".repeat(25)}`;
  const f = fixture(async (url) => String(url).endsWith("/stop")
    ? Response.json({ message: `Cannot stop this codespace. ${credential}` }, { status: 409 })
    : Response.json(space("automatic-owned", "Available")));
  try {
    f.add("phone-aaaa", 1, "automatic-owned");
    f.database.prepare("UPDATE phones SET state = 'running'").run();
    await assert.rejects(f.service.stop(1, "phone-aaaa"), error => error instanceof GitHubError && error.status === 409);
    const row = f.database.prepare("SELECT state, state_detail, last_stopped_at FROM phones").get()!;
    assert.equal(row.state, "running");
    assert.equal(row.last_stopped_at, null);
    assert.equal(row.state_detail, "Cannot stop this codespace. [redacted]");
    assert.deepEqual(f.database.prepare("SELECT kind FROM events ORDER BY id").all().map(row => row.kind), ["action", "error"]);
    assert.ok(!JSON.stringify(f.database.prepare("SELECT message FROM events").all()).includes(credential));
  } finally { await f.close(); }
});

test("overlapping start and stop requests cannot race on the same phone", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    entered.resolve();
    await release.promise;
    return Response.json(space("automatic-owned", "Starting"));
  });
  let starting: Promise<string> | undefined;
  try {
    f.add("phone-aaaa", 1, "automatic-owned");
    starting = f.service.start(1, "phone-aaaa");
    await entered.promise;
    await assert.rejects(f.service.stop(1, "phone-aaaa"), /already in progress/);
    assert.equal(calls, 1);
    release.resolve();
    await starting;
    assert.equal(f.database.prepare("SELECT state FROM phones").get()?.state, "booting");
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM events WHERE kind = 'action'").get()?.n, 1);
  } finally { release.resolve(); await starting; await f.close(); }
});

test("runs accrue across restarts, reconcile idle stops, and keep each account's budget separate", async () => {
  let current = space("automatic-owned");
  const f = fixture(async url => {
    if (String(url).endsWith("/start")) current = space(current.name, "Starting");
    return new URL(String(url)).pathname === "/user/codespaces"
      ? Response.json({ codespaces: [current] }) : Response.json(current);
  });
  const clock = () => Date.parse("2026-11-07T02:00:00Z");
  try {
    f.add("phone-aaaa", 1, current.name);
    f.database.exec("UPDATE phones SET idle_timeout_min = 30");
    await f.service.start(1, "phone-aaaa");
    f.advance(3_600_000);
    await f.service.start(1, "phone-aaaa");
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM runs").get()?.n, 1);
    assert.equal((await readUsage(f.asyncDatabase, 1, clock)).used_core_hours, 4);
    assert.equal((await readUsage(f.asyncDatabase, 2, clock)).used_core_hours, 0);
    f.advance(3_600_000);
    current = { ...space(current.name), last_used_at: "2026-11-07T00:30:00Z" };
    await f.service.sync(1);
    assert.equal((await readUsage(f.asyncDatabase, 1, clock)).used_core_hours, 2);
    assert.deepEqual((await readUsage(f.asyncDatabase, 1, clock)).running, []);
    await f.service.sync(1);
    await f.service.start(1, "phone-aaaa");
    f.advance(3_600_000);
    const later = () => Date.parse("2026-11-07T03:00:00Z");
    assert.equal((await readUsage(f.asyncDatabase, 1, later)).used_core_hours, 4);
    await saveAllowance(f.asyncDatabase, 1, 180);
    assert.equal((await readUsage(f.asyncDatabase, 1, later)).allowance_core_hours, 180);
    assert.equal((await readUsage(f.asyncDatabase, 2, later)).allowance_core_hours, 120);
    for (const invalid of [-1, Infinity, NaN]) await assert.rejects(saveAllowance(f.asyncDatabase, 1, invalid));
    assert.equal((await readUsage(f.asyncDatabase, 1, later)).allowance_core_hours, 180);
  } finally { await f.close(); }
});

test("the optional operator cap blocks creation before HTTP but never prevents stopping", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return Response.json(space("generated-phone-aaaa")); });
  try {
    f.add("phone-aaaa");
    const service = createPhoneService({ database: f.asyncDatabase, github: f.github, encrypt: value => Buffer.from(value),
      maxPhones: 1, clock: () => Date.parse("2026-11-07T00:00:00Z") });
    await assert.rejects(service.create(1, input), /safety cap/);
    assert.equal(calls, 0);
    await service.stop(1, "phone-aaaa");
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test("Stop all handles more than six phones, preserves other users, and reports partial GitHub refusals", async () => {
  const writes: string[] = [];
  const f = fixture(async (url, init) => {
    const name = new URL(String(url)).pathname.split("/")[3]!;
    if (init?.method === "POST") {
      writes.push(name);
      return name === "generated-phone-0003" ? Response.json({ message: "Try later" }, { status: 409 }) : new Response(null, { status: 202 });
    }
    return Response.json(space(name, "Available"));
  });
  try {
    for (let n = 0; n < 8; n++) f.add(`phone-000${n}`);
    f.add("phone-ffff", 2);
    f.database.exec("UPDATE phones SET state = 'running'");
    assert.deepEqual(await f.service.stopAll(1), { stopped: 7, errors: ["Try later"] });
    assert.equal(writes.length, 8);
    assert.ok(!writes.includes("generated-phone-ffff"));
    assert.equal(f.database.prepare("SELECT state FROM phones WHERE id = 'phone-ffff'").get()?.state, "running");
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM phones").get()?.n, 9);
  } finally { await f.close(); }
});

test("phone HTTP API authenticates, rejects cross-site creation, passes defaults, and preserves GitHub refusals as 409", async () => {
  let posts = 0;
  let refuse = true;
  const f = fixture(async url => {
    // The API always asks for the 4-core phone machine.
    if (String(url).endsWith("/machines")) return Response.json({ machines: [PHONE_MACHINE] });
    posts++;
    return refuse ? Response.json({ message: "Your spending limit has been reached." }, { status: 403 })
      : Response.json(space("new-api-phone", "Creating"));
  });
  await updateSettings(f.asyncDatabase, 1, { default_idle_min: 240 });
  let signedIn = false;
  const api = createPhoneApi({ user: async () => signedIn ? { id: 1 } : null, service: f.service,
    template: () => input, usage: async id => (await readUsage(f.asyncDatabase, id, () => Date.parse("2026-11-07T00:00:00Z"))),
    defaults: id => userSettings(f.asyncDatabase, id) });
  const request = (origin?: string, body = "{}") => new Request("http://localhost/v1/phones", { method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body });
  try {
    assert.equal((await api.usage()).status, 401);
    assert.equal((await api.create(request())).status, 401);
    signedIn = true;
    assert.equal((await api.create(request("https://foreign.invalid"))).status, 403);
    assert.equal((await api.create(request(undefined, "[]"))).status, 400);
    const response = await api.create(request());
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "github_refused", message: "Your spending limit has been reached." });
    assert.equal(posts, 1);
    const usage = await api.usage();
    assert.equal(usage.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await usage.json(), { allowance_core_hours: 120, used_core_hours: 0,
      running: [], hours_left_at_current_rate: null, month: "2026-11", estimated: true });
    refuse = false;
    f.advance(60_000);
    const created = await api.create(request());
    assert.equal(created.status, 201);
    const { id } = await created.json();
    assert.match(id, /^phone-[a-z]+-[a-z]+$/);
    assert.equal(f.database.prepare("SELECT idle_timeout_min FROM phones WHERE id = ?").get(id)?.idle_timeout_min, 240);
    assert.equal(posts, 2);
  } finally { await f.close(); }
});

test("reconciliation splits runs when cores change and closes missing codespaces without losing usage history", async () => {
  let current: Codespace | null = space("automatic-owned", "Available");
  const f = fixture(async () => Response.json({ codespaces: current ? [current] : [] }));
  const clock = () => Date.parse("2026-11-07T02:00:00Z");
  try {
    f.add("phone-aaaa", 1, "automatic-owned");
    await f.service.sync(1);
    f.advance(3_600_000);
    current = { ...current!, machine: { name: "larger", cpus: 4 } };
    await f.service.sync(1);
    f.advance(3_600_000);
    assert.equal((await readUsage(f.asyncDatabase, 1, clock)).used_core_hours, 6);
    assert.deepEqual((await readUsage(f.asyncDatabase, 1, clock)).running, [{ id: "phone-aaaa", cores: 4 }]);
    current = null;
    await f.service.sync(1);
    assert.equal((await readUsage(f.asyncDatabase, 1, clock)).used_core_hours, 6);
    assert.deepEqual((await readUsage(f.asyncDatabase, 1, clock)).running, []);
    assert.equal(f.database.prepare("SELECT state FROM phones").get()?.state, "deleted");
  } finally { await f.close(); }
});

test("the state poller avoids overlap, backs off GitHub refusals with a fake clock, and skips blocked users", async () => {
  const f = fixture(async () => { throw new Error("No HTTP expected"); });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let time = 0;
  const calls: number[] = [];
  try {
    f.add("phone-aaaa");
    f.add("phone-bbbb", 2);
    f.database.exec("UPDATE users SET blocked = 1 WHERE id = 2");
    const tick = createStatePoller({ database: f.asyncDatabase, clock: () => time, sync: async id => {
      calls.push(id);
      entered.resolve();
      await release.promise;
      if (calls.length === 1) throw new GitHubError("Rate limit", 429);
    } });
    const first = tick();
    await entered.promise;
    await tick();
    assert.deepEqual(calls, [1]);
    release.resolve();
    await first;
    time = 299_999;
    await tick();
    assert.deepEqual(calls, [1]);
    time = 300_000;
    await tick();
    assert.deepEqual(calls, [1, 1]);
  } finally { release.resolve(); await f.close(); }
});

test("an Available codespace starts phone setup, checks it until ready, then the phone is running; a failure waits before retrying", async () => {
  const f = fixture(async () => Response.json({ codespaces: [space("generated-phone-cccc", "Available")] }));
  const runs: string[] = [];
  let fail = true;
  const service = createPhoneService({ database: f.asyncDatabase, github: f.github, encrypt: (plain, context) => seal(plain, key, context),
    setup: async (_user, name) => { runs.push(name); if (fail) throw new Error("apt failed"); return "ready"; } });
  const state = () => f.database.prepare("SELECT state, state_detail FROM phones WHERE id = 'phone-cccc'").get() as
    { state: string; state_detail: string | null };
  try {
    f.add("phone-cccc");
    await service.sync(1);
    await service.sync(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(runs, ["generated-phone-cccc"]);
    assert.equal(state().state, "booting");
    assert.match(state().state_detail ?? "", /Phone setup failed.*10 minutes/);
    assert.equal(f.database.prepare("SELECT failed FROM phone_setup_attempts").get()?.failed, 1);
    await service.sync(1);
    assert.equal(runs.length, 1, "a failed setup waits before it runs again");

    fail = false;
    f.database.prepare("UPDATE phones SET state_detail = ? WHERE id = 'phone-cccc'").run("Setup needs another attempt. New wording.");
    let now = Date.now();
    let status: "working" | "ready" = "working";
    const ready = createPhoneService({ database: f.asyncDatabase, github: f.github, encrypt: (plain, context) => seal(plain, key, context),
      clock: () => now, setup: async (_user, name) => { runs.push(name); return status; } });
    await ready.sync(1);
    await flush();
    assert.equal(runs.length, 1, "a server restart preserves the ten-minute failure backoff");
    assert.equal(f.database.prepare("SELECT failed FROM phone_setup_attempts").get()?.failed, 1);
    assert.equal(state().state_detail, "Setup needs another attempt. New wording.");
    now += 10 * 60_000 + 1;
    await ready.sync(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state().state, "booting", "setup still works in the codespace");
    assert.equal(f.database.prepare("SELECT failed FROM phone_setup_attempts").get()?.failed, 0);
    assert.match(state().state_detail ?? "", /Installing Android/);
    for (let i = 0; i < 200 && runs.length < 13; i++) await flush();
    assert.equal(runs.length, 13, "working checks chain at once and stop after twelve");
    await ready.sync(1);
    assert.equal(runs.length, 13, "the chain limit hands back to the poller");
    now += 21_000;
    status = "ready";
    await ready.sync(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runs.length, 14);
    assert.equal(state().state, "running");
    assert.equal(state().state_detail, null);
    assert.equal(f.database.prepare("SELECT 1 FROM phone_setup_attempts").get(), undefined);
  } finally { await f.close(); }
});

test("a pending start watches GitHub and starts setup when Available without a sync call", async () => {
  let current = space("generated-phone-aaaa", "Shutdown");
  const f = fixture(async url => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/start")) { current = space(current.name, "Starting"); return Response.json(current); }
    return Response.json(current);
  });
  const runs: string[] = [];
  const service = createPhoneService({ database: f.asyncDatabase, github: f.github, encrypt: (plain, context) => seal(plain, key, context),
    sleep: async () => { await flush(); },
    setup: async (_user, name) => { runs.push(name); return "ready"; } });
  try {
    f.add("phone-aaaa", 1, current.name);
    await service.start(1, "phone-aaaa");
    assert.equal(f.database.prepare("SELECT state FROM phones").get()?.state, "booting");
    current = space(current.name, "Available");
    for (let i = 0; i < 200 && !runs.length; i++) await flush();
    assert.deepEqual(runs, ["generated-phone-aaaa"]);
  } finally { await f.close(); }
});

test("the start watch stops at once on a GitHub rate limit", async () => {
  let current = space("generated-phone-aaaa", "Shutdown");
  let gets = 0;
  let firstGet = true;
  const f = fixture(async url => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/start")) { current = space(current.name, "Starting"); return Response.json(current); }
    if (firstGet) { firstGet = false; return Response.json(current); }
    gets++;
    return Response.json({ message: "Rate limit" }, { status: 429 });
  });
  let setupCalls = 0;
  const service = createPhoneService({ database: f.asyncDatabase, github: f.github, encrypt: (plain, context) => seal(plain, key, context),
    sleep: async () => { await flush(); }, setup: async () => { setupCalls++; return "working"; } });
  try {
    f.add("phone-aaaa", 1, current.name);
    await service.start(1, "phone-aaaa");
    for (let i = 0; i < 50; i++) await flush();
    assert.equal(gets, 1);
    for (let i = 0; i < 50; i++) await flush();
    assert.equal(gets, 1, "a 429 stops the watch without a retry");
    assert.equal(setupCalls, 0);
  } finally { await f.close(); }
});

test("the start watch stops when the phone is no longer booting", async () => {
  let current = space("generated-phone-aaaa", "Shutdown");
  let gets = 0;
  let firstGet = true;
  const f = fixture(async url => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/start")) { current = space(current.name, "Starting"); return Response.json(current); }
    if (firstGet) { firstGet = false; return Response.json(current); }
    gets++;
    return Response.json(current);
  });
  let setupCalls = 0;
  const service = createPhoneService({ database: f.asyncDatabase, github: f.github, encrypt: (plain, context) => seal(plain, key, context),
    sleep: async () => {
      f.database.prepare("UPDATE phones SET state = 'stopping' WHERE id = 'phone-aaaa'").run();
      await flush();
    },
    setup: async () => { setupCalls++; return "working"; } });
  try {
    f.add("phone-aaaa", 1, current.name);
    await service.start(1, "phone-aaaa");
    for (let i = 0; i < 50; i++) await flush();
    assert.equal(f.database.prepare("SELECT state FROM phones").get()?.state, "stopping");
    assert.equal(gets, 0, "the watch does not ask GitHub after the phone stops");
    assert.equal(setupCalls, 0);
  } finally { await f.close(); }
});

test("a working setup check re-checks at once and boots without another sync", async () => {
  const f = fixture(async () => Response.json({ codespaces: [space("generated-phone-aaaa", "Available")] }));
  let checks = 0, boots = 0;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const service = createPhoneService({ database: f.asyncDatabase, github: f.github, encrypt: (plain, context) => seal(plain, key, context),
    setup: async () => { checks++; if (checks === 1) { entered.resolve(); await release.promise; return "working"; } return "ready"; },
    runner: async () => { boots++; return Response.json({ booted: true }); } });
  try {
    f.add("phone-aaaa");
    await service.sync(1);
    await entered.promise;
    release.resolve();
    for (let i = 0; i < 200 && !boots; i++) await flush();
    assert.equal(checks, 2, "the next check runs without another sync");
    assert.equal(boots, 1);
    assert.equal(f.database.prepare("SELECT state FROM phones").get()?.state, "running");
  } finally { release.resolve(); await flush(); await f.close(); }
});

test("a failed setup check does not re-call setup", async () => {
  const f = fixture(async () => Response.json({ codespaces: [space("generated-phone-aaaa", "Available")] }));
  let checks = 0;
  const service = createPhoneService({ database: f.asyncDatabase, github: f.github, encrypt: (plain, context) => seal(plain, key, context),
    setup: async () => { checks++; throw new Error("setup failed"); } });
  try {
    f.add("phone-aaaa");
    await service.sync(1);
    for (let i = 0; i < 200 && !checks; i++) await flush();
    for (let i = 0; i < 50; i++) await flush();
    assert.equal(checks, 1);
    assert.equal(f.database.prepare("SELECT failed FROM phone_setup_attempts").get()?.failed, 1);
  } finally { await f.close(); }
});

test("setup boots Android once, persists failures until Retry boot, and records readiness", async () => {
  const f = fixture(async () => Response.json({ codespaces: [space("generated-phone-aaaa", "Available")] }));
  let boot = Promise.withResolvers<Response>();
  let boots = 0;
  const service = createPhoneService({ database: f.asyncDatabase, github: f.github, encrypt: (plain, context) => seal(plain, key, context),
    setup: async () => "ready", runner: async (_user, _id, path, body) => {
      assert.equal(path, "/boot");
      assert.deepEqual(body, {});
      boots++;
      return boot.promise;
    } });
  const android = () => f.database.prepare("SELECT android_state, android_error FROM phones WHERE id = 'phone-aaaa'").get()!;
  try {
    f.add("phone-aaaa");
    await service.sync(1);
    await flush();
    assert.equal(android().android_state, "booting");
    await service.sync(1);
    assert.equal(boots, 1);
    boot.resolve(Response.json({ booted: false }));
    await flush();
    assert.equal(android().android_state, "failed");
    assert.equal(android().android_error, "Android boot failed. Retry boot.");
    await service.sync(1);
    assert.equal(boots, 1, "failed boots need an explicit retry");
    boot = Promise.withResolvers<Response>();
    await service.retryBoot(1, "phone-aaaa");
    await assert.rejects(service.retryBoot(2, "phone-aaaa"), /Phone not found/);
    await assert.rejects(service.retryBoot(1, "phone-aaaa"), /Wait until/);
    boot.resolve(Response.json({ booted: true }));
    await flush();
    assert.equal(android().android_state, "ready");
    const messages = f.database.prepare("SELECT message FROM events WHERE phone_id = 'phone-aaaa' ORDER BY id").all().map(row => row.message);
    const runnerReady = messages.indexOf("Phone runner ready");
    assert.ok(runnerReady >= 0 && runnerReady < messages.indexOf("Android starting"));
    assert.ok(messages.some(message => /^Android ready \(took \d+ s\)$/.test(String(message))));
  } finally { boot.resolve(Response.json({ booted: false })); await flush(); await f.close(); }
});

test("Stop waits for the runner before stopping GitHub and ignores a late boot completion", async () => {
  let githubStops = 0;
  const f = fixture(async (url, init) => {
    if (init?.method === "POST" && String(url).endsWith("/stop")) { githubStops++; return new Response(null, { status: 202 }); }
    if (String(url).includes("?")) return Response.json({ codespaces: [space("generated-phone-aaaa", "Available")] });
    return Response.json(space("generated-phone-aaaa", "Available"));
  });
  const boot = Promise.withResolvers<Response>();
  const stop = Promise.withResolvers<Response>();
  const enteredStop = Promise.withResolvers<void>();
  const service = createPhoneService({ database: f.asyncDatabase, github: f.github, encrypt: (plain, context) => seal(plain, key, context),
    runner: async (_user, _id, path) => {
      if (path === "/boot") return boot.promise;
      enteredStop.resolve();
      return stop.promise;
    } });
  try {
    f.add("phone-aaaa");
    f.database.exec("UPDATE phones SET state = 'running'");
    await service.retryBoot(1, "phone-aaaa");
    const stopping = service.stop(1, "phone-aaaa");
    await enteredStop.promise;
    assert.equal(githubStops, 0);
    boot.resolve(Response.json({ booted: true }));
    await flush();
    assert.equal(f.database.prepare("SELECT android_state FROM phones").get()?.android_state, "stopping");
    stop.resolve(Response.json({ stopped: true }));
    await stopping;
    assert.equal(githubStops, 1);
    assert.equal(f.database.prepare("SELECT state FROM phones").get()?.state, "stopping");
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM events WHERE message LIKE 'Android ready%'").get()?.n, 0);
  } finally { boot.resolve(Response.json({ booted: false })); stop.resolve(Response.json({ stopped: true })); await flush(); await f.close(); }
});

test("runner and GitHub stop failures preserve the running codespace and leave a recoverable status", async () => {
  let githubStops = 0, runnerFails = true;
  const f = fixture(async (_url, init) => {
    if (init?.method === "POST") { githubStops++; throw new GitHubError("synthetic GitHub stop refusal", 503); }
    return Response.json(space("generated-phone-aaaa", "Available"));
  });
  const service = createPhoneService({ database: f.asyncDatabase, github: f.github, encrypt: (plain, context) => seal(plain, key, context),
    runner: async () => {
      if (runnerFails) throw new Error("synthetic transport failure");
      return Response.json({ stopped: true });
    } });
  try {
    f.add("phone-aaaa");
    f.database.exec("UPDATE phones SET state = 'running', android_state = 'ready'");
    await assert.rejects(service.stop(1, "phone-aaaa"), /codespace is still running/);
    assert.equal(githubStops, 0);
    assert.equal(f.database.prepare("SELECT state FROM phones").get()?.state, "running");
    runnerFails = false;
    await assert.rejects(service.stop(1, "phone-aaaa"), /synthetic GitHub stop refusal/);
    assert.equal(githubStops, 1);
    assert.equal(f.database.prepare("SELECT android_state FROM phones").get()?.android_state, "failed");
  } finally { await f.close(); }
});
