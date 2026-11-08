import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database.ts";
import { createGitHubClient, GitHubError, type Codespace } from "../github/github.ts";
import { createPhoneService } from "../phone/phone-mutations.ts";
import { createPhoneApi } from "../phone/phone-api.ts";
import { createStatePoller } from "../phone/poller.ts";
import { retentionStatus } from "./retention.ts";
import { updateSettings } from "./settings.ts";
import { readUsage } from "./usage.ts";
import type { OutgoingEvent } from "./events.ts";

const DAY = 86_400_000;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "phonelink-retention-"));
  const filename = join(directory, "test.db");
  let database = openDatabase(filename);
  let time = Date.parse("2026-11-07T00:00:00Z");
  const clock = () => time;
  const spaces = new Map<string, Codespace>();
  const writes: string[] = [];
  const outgoing: OutgoingEvent[] = [];
  const failures = new Map<string, number>();
  const emit = (event: OutgoingEvent) => { outgoing.push(event); };
  for (const id of [1, 2]) database.prepare(`INSERT INTO users
    (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
    VALUES (?, ?, 'fixture', ?, 'codespace', '2026-11-01', '2026-11-01')`).run(id, id, Buffer.from("sealed-fixture"));
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/user/codespaces") return Response.json({ codespaces: [...spaces.values(),
      { id: 999, name: "foreign-unregistered", state: "Shutdown", retention_expires_at: new Date(time).toISOString() }] });
    const name = path.split("/")[3]!;
    const space = spaces.get(name);
    assert.ok(space, `Unexpected codespace: ${name}`);
    if (init?.method === "POST") {
      writes.push(path);
      const status = failures.get(path);
      if (status) return Response.json({ message: "Synthetic refusal" }, { status });
      if (path.endsWith("/start")) {
        space.state = "Starting";
        space.retention_expires_at = null;
        return Response.json(space);
      }
      assert.ok(path.endsWith("/stop"));
      // Stop is asynchronous. Only the test confirms Shutdown.
      return new Response(null, { status: 202 });
    }
    return Response.json(space);
  };
  const makeService = () => createPhoneService({ database, clock, emit, encrypt: value => Buffer.from(value),
    github: createGitHubClient({ database, accessToken: async () => "synthetic-token", fetch: fetcher }) });
  let service = makeService();
  const makeTick = () => createStatePoller({ database, clock, emit, sync: service.sync,
    autoKeep: service.autoKeep, autoStop: service.autoStop });
  return {
    get database() { return database; }, get service() { return service; },
    clock, spaces, writes, outgoing, failures, makeTick,
    advance(ms: number) { time += ms; },
    restart() { database.close(); database = openDatabase(filename); service = makeService(); },
    add(id = "phone-aaaa", userId = 1, days = 3) {
      const name = `generated-${id}`;
      const expiry = new Date(time + days * DAY).toISOString();
      const stopped = new Date(time + (days - 30) * DAY).toISOString();
      database.prepare(`INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, cores, state,
        created_at, last_stopped_at, retention_at, retention_min, runner_secret)
        VALUES (?, ?, ?, 'fixture/template', 'fixture', 2, 'stopped', ?, ?, ?, 43200, ?)`)
        .run(id, userId, name, stopped, stopped, expiry, Buffer.from("sealed-runner"));
      spaces.set(name, { id: spaces.size + 1, name, state: "Shutdown", retention_expires_at: expiry,
        machine: { name: "fixture", cpus: 2 } });
    },
    close() { database.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("countdown uses stop time, honors provider expiry and distinguishes the exact two-day boundary", () => {
  const stopped = Date.parse("2026-11-01T00:00:00Z");
  let time = stopped + 25 * DAY;
  const phone = { state: "stopped", retention_at: null as string | null,
    last_stopped_at: new Date(stopped).toISOString(), retention_min: 43200 };
  const clock = () => time;
  assert.deepEqual(retentionStatus(phone, clock), {
    message: "GitHub deletes this phone in 5 days unless you use it.", warning: false, canKeep: false,
    expiresAt: "2026-12-01T00:00:00.000Z",
  });
  phone.retention_at = new Date(time + 2 * DAY).toISOString();
  assert.equal(retentionStatus(phone, clock)?.canKeep, true);
  assert.equal(retentionStatus(phone, clock)?.warning, false);
  time++;
  assert.equal(retentionStatus(phone, clock)?.warning, true);
  time += DAY;
  assert.equal(retentionStatus(phone, clock)?.message, "GitHub deletes this phone in 1 day unless you use it.");
  time += DAY;
  assert.match(retentionStatus(phone, clock)!.message, /at any time/);
  assert.equal(retentionStatus({ ...phone, state: "running" }, clock), null);
  assert.equal(retentionStatus({ ...phone, retention_at: "invalid", last_stopped_at: null }, clock), null);
});

test("sync honors provider dates, preserves them when omitted, and calculates a new date after a stop", async () => {
  const f = fixture();
  try {
    f.add();
    const space = f.spaces.get("generated-phone-aaaa")!;
    space.retention_expires_at = new Date(f.clock() + 5 * DAY).toISOString();
    await f.service.sync(1);
    assert.equal(f.database.prepare("SELECT retention_at FROM phones").get()?.retention_at, "2026-11-12T00:00:00.000Z");
    delete space.retention_expires_at;
    await f.service.sync(1);
    assert.equal(f.database.prepare("SELECT retention_at FROM phones").get()?.retention_at, "2026-11-12T00:00:00.000Z");
    space.state = "Available";
    await f.service.sync(1);
    assert.equal(f.database.prepare("SELECT retention_at FROM phones").get()?.retention_at, null);
    f.advance(60_000);
    space.state = "Shutdown";
    await f.service.sync(1);
    assert.deepEqual({ ...f.database.prepare("SELECT last_stopped_at, retention_at FROM phones").get() }, {
      last_stopped_at: "2026-11-07T00:01:00.000Z", retention_at: "2026-12-07T00:01:00.000Z",
    });
  } finally { f.close(); }
});

test("Keep it waits for Available, resumes after restart, confirms shutdown, resets retention and charges the run", async () => {
  const f = fixture();
  try {
    f.add(); f.add("phone-bbbb", 2);
    const before = f.database.prepare("SELECT codespace_name, runner_secret FROM phones WHERE id = 'phone-aaaa'").get();
    await f.service.keep(1, "phone-aaaa");
    await f.service.keep(1, "phone-aaaa");
    await assert.rejects(f.service.start(1, "phone-aaaa"), /in progress/);
    await assert.rejects(f.service.stop(1, "phone-aaaa"), /in progress/);
    f.advance(60_000);
    await f.service.sync(1); // Starting is not Available.
    assert.deepEqual(f.writes, ["/user/codespaces/generated-phone-aaaa/start"]);
    assert.equal(f.outgoing.filter(e => e.type === "phone.kept").length, 0);
    f.restart();
    f.spaces.get("generated-phone-aaaa")!.state = "Available";
    await f.service.sync(1);
    assert.deepEqual(f.writes, ["/user/codespaces/generated-phone-aaaa/start", "/user/codespaces/generated-phone-aaaa/stop"]);
    await f.service.sync(1); // Stale Available must not duplicate the stop or report success.
    assert.equal(f.writes.length, 2);
    assert.equal(f.outgoing.filter(e => e.type === "phone.kept").length, 0);
    f.advance(60_000);
    f.spaces.get("generated-phone-aaaa")!.state = "ShuttingDown";
    await f.service.sync(1);
    f.advance(60_000);
    f.spaces.get("generated-phone-aaaa")!.state = "Shutdown";
    await f.service.sync(1);
    await f.service.sync(1);
    const kept = f.outgoing.filter(e => e.type === "phone.kept");
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.data.retention_at, "2026-12-07T00:03:00.000Z");
    assert.equal(f.database.prepare("SELECT state FROM phones WHERE id = 'phone-aaaa'").get()?.state, "stopped");
    assert.equal(readUsage(f.database, 1, f.clock).used_core_hours, 0.1);
    assert.equal(readUsage(f.database, 1, f.clock).running.length, 0);
    assert.deepEqual(f.database.prepare("SELECT codespace_name, runner_secret FROM phones WHERE id = 'phone-aaaa'").get(), before);
    assert.ok(!JSON.stringify(f.outgoing).includes("sealed-runner"));
  } finally { f.close(); }
});

test("retention warnings fire once each per stopped period, survive restart and renew after a keep", async () => {
  const f = fixture();
  try {
    f.add();
    await f.makeTick()();
    assert.equal(f.outgoing.length, 0);
    f.advance(DAY);
    await f.makeTick()();
    f.restart();
    await f.makeTick()();
    assert.deepEqual(f.outgoing.map(e => e.data.days), [2]);
    f.advance(DAY);
    await f.makeTick()();
    await f.makeTick()();
    assert.deepEqual(f.outgoing.map(e => e.data.days), [2, 1]);
    assert.equal(f.writes.length, 0); // Auto-keep is off by default.
    await f.service.keep(1, "phone-aaaa");
    f.advance(60_000);
    f.spaces.get("generated-phone-aaaa")!.state = "Available";
    await f.service.sync(1);
    f.advance(60_000);
    f.spaces.get("generated-phone-aaaa")!.state = "Shutdown";
    await f.service.sync(1);
    f.advance(28 * DAY);
    await f.makeTick()();
    f.advance(DAY);
    await f.makeTick()();
    assert.deepEqual(f.outgoing.filter(e => e.type === "retention.warning").map(e => e.data.days), [2, 1, 2, 1]);
  } finally { f.close(); }
});

test("auto-keep starts only opted-in stopped phones at one day, once, and backs off provider rate limits", async () => {
  const f = fixture();
  try {
    f.add("phone-aaaa", 1, 1); f.add("phone-bbbb", 1, 1); f.add("phone-cccc", 2, 1);
    f.add("phone-dddd", 1, 2);
    updateSettings(f.database, 1, { auto_keep: true });
    const start = "/user/codespaces/generated-phone-aaaa/start";
    f.failures.set(start, 429);
    const tick = f.makeTick();
    await tick();
    assert.deepEqual(f.writes, [start]);
    f.failures.clear();
    f.advance(299_999);
    await tick();
    assert.equal(f.writes.length, 1);
    f.advance(1);
    await tick();
    assert.deepEqual(f.writes, [start, start, "/user/codespaces/generated-phone-bbbb/start"]);
    await f.makeTick()();
    assert.equal(f.writes.length, 3);
    assert.equal(f.outgoing.filter(e => e.type === "phone.kept").length, 0);
    assert.equal(f.database.prepare("SELECT state FROM phones WHERE id = 'phone-cccc'").get()?.state, "stopped");
    assert.equal(f.database.prepare("SELECT state FROM phones WHERE id = 'phone-dddd'").get()?.state, "stopped");
  } finally { f.close(); }
});

test("keep API authenticates, rejects foreign phones and cross-site calls, and returns accepted instead of false success", async () => {
  const f = fixture();
  try {
    f.add(); f.add("phone-bbbb", 2);
    let signedIn = false;
    const api = createPhoneApi({ user: async () => signedIn ? { id: 1 } : null, service: f.service,
      template: () => { throw new Error("No creation expected"); },
      usage: id => readUsage(f.database, id, f.clock), defaults: () => ({ default_machine: null, default_idle_min: 30 }) });
    const request = (headers = {}) => new Request("http://localhost/v1/phones/phone-aaaa/keep", { method: "POST", headers });
    assert.equal((await api.keep(request(), "phone-aaaa")).status, 401);
    signedIn = true;
    assert.equal((await api.keep(request({ Origin: "https://foreign.invalid" }), "phone-aaaa")).status, 403);
    assert.equal((await api.keep(request({ "sec-fetch-site": "cross-site" }), "phone-aaaa")).status, 403);
    assert.equal((await api.keep(request(), "phone-bbbb")).status, 400);
    assert.equal((await api.keep(request(), "generated-phone-aaaa")).status, 400);
    assert.equal(f.writes.length, 0);
    const response = await api.keep(request(), "phone-aaaa");
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { id: "phone-aaaa", status: "keeping" });
    assert.equal(f.outgoing.filter(e => e.type === "phone.kept").length, 0);
    assert.equal((await api.keep(request(), "phone-aaaa")).status, 202);
    assert.equal(f.writes.length, 1);
    await assert.rejects(f.service.keep(1, "phone-bbbb"), /not found/);
    f.database.exec("UPDATE users SET blocked = 1 WHERE id = 2");
    await assert.rejects(f.service.keep(2, "phone-bbbb"), /Sign in again/);
  } finally { f.close(); }
});

test("a failed stop during Keep it retries and finishes only after GitHub confirms Shutdown", async () => {
  const f = fixture();
  try {
    f.add();
    await f.service.keep(1, "phone-aaaa");
    f.advance(60_000);
    f.spaces.get("generated-phone-aaaa")!.state = "Available";
    const stop = "/user/codespaces/generated-phone-aaaa/stop";
    f.failures.set(stop, 500);
    await assert.rejects(f.service.sync(1), GitHubError);
    assert.equal(f.outgoing.filter(e => e.type === "phone.kept").length, 0);
    f.restart();
    f.failures.clear();
    f.advance(60_000);
    await f.service.sync(1);
    assert.deepEqual(f.writes, ["/user/codespaces/generated-phone-aaaa/start", stop, stop]);
    f.advance(60_000);
    f.spaces.get("generated-phone-aaaa")!.state = "Shutdown";
    await f.service.sync(1);
    assert.equal(f.outgoing.filter(e => e.type === "phone.kept").length, 1);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM phone_keeps").get()?.n, 0);
  } finally { f.close(); }
});

test("keep refuses active phones and stale stopped state without stopping a user's running codespace", async () => {
  const f = fixture();
  try {
    f.add();
    f.spaces.get("generated-phone-aaaa")!.state = "Available";
    await assert.rejects(f.service.keep(1, "phone-aaaa"), /no longer stopped/);
    assert.equal(f.writes.length, 0);
    await assert.rejects(f.service.keep(1, "phone-aaaa"), /Only a stopped phone/);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM phone_keeps").get()?.n, 0);
  } finally { f.close(); }
});

test("manual keep shares the interactive rate limit; automatic keep can protect more than six phones", async () => {
  const f = fixture();
  try {
    for (let n = 0; n < 8; n++) f.add(`phone-000${n}`, 1, 1);
    for (let n = 0; n < 6; n++) await f.service.keep(1, `phone-000${n}`);
    await assert.rejects(f.service.keep(1, "phone-0006"), /Too many phone requests/);
    assert.equal(f.writes.length, 6);
    updateSettings(f.database, 1, { auto_keep: true });
    await f.makeTick()();
    assert.equal(f.writes.length, 8);
  } finally { f.close(); }
});

test("an externally renewed provider expiry gets new warnings even if both polls see Shutdown", async () => {
  const f = fixture();
  try {
    f.add("phone-aaaa", 1, 1);
    await f.makeTick()();
    assert.deepEqual(f.outgoing.map(e => e.data.days), [1], "only the nearest threshold");
    f.spaces.get("generated-phone-aaaa")!.retention_expires_at = new Date(f.clock() + 30 * DAY).toISOString();
    await f.makeTick()();
    f.advance(29 * DAY);
    await f.makeTick()();
    assert.deepEqual(f.outgoing.map(e => e.data.days), [1, 1]);
  } finally { f.close(); }
});

test("GitHub failure or deletion during a keep clears the request without emitting phone.kept", async () => {
  for (const state of ["Failed", "Deleted"]) {
    const f = fixture();
    try {
      f.add();
      await f.service.keep(1, "phone-aaaa");
      f.advance(60_000);
      f.spaces.get("generated-phone-aaaa")!.state = state;
      await f.service.sync(1);
      assert.equal(f.database.prepare("SELECT count(*) AS n FROM phone_keeps").get()?.n, 0);
      assert.equal(f.outgoing.filter(e => e.type === "phone.kept").length, 0);
      assert.equal(f.writes.length, 1);
    } finally { f.close(); }
  }
});

test("auto-stop and auto-keep coexist without interrupting keeps or blocking other phones", async () => {
  const f = fixture();
  try {
    f.add("phone-aaaa", 1, 1); f.add("phone-bbbb", 1, 1);
    updateSettings(f.database, 1, { auto_keep: true, auto_stop_before_empty: true, allowance_core_hours: 0 });
    const tick = f.makeTick();
    await tick();
    f.advance(60_000);
    await tick(); // Both are Starting, so the keep workflow still owns their stops.
    assert.equal(f.writes.length, 2);
    f.add("phone-cccc", 1, 1);
    await tick();
    assert.equal(f.writes.length, 3); // Existing keeps must not block this new automatic keep.
    f.advance(60_000);
    for (const space of f.spaces.values()) space.state = "Available";
    await tick();
    assert.equal(f.writes.filter(path => path.endsWith("/stop")).length, 3);
    f.advance(60_000);
    for (const space of f.spaces.values()) space.state = "Shutdown";
    await tick();
    assert.equal(f.outgoing.filter(e => e.type === "phone.kept").length, 3);
    assert.equal(readUsage(f.database, 1, f.clock).running.length, 0);
  } finally { f.close(); }
});
