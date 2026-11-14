import { pathToFileURL } from "node:url";
import { createClient } from "../data/async-database.ts";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../data/database.ts";
import { createGitHubClient, type Codespace } from "../github/github.ts";
import { createPhoneService } from "./phone-mutations.ts";
import { createStatePoller } from "./poller.ts";
import { updateSettings } from "../data/settings.ts";
import { readUsage } from "../data/usage.ts";
import { hoursWarning, unreadAutoStops, acknowledgeAutoStops } from "../shared/hours.ts";
import type { OutgoingEvent } from "../data/events.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "emuly-poller-"));
  const database = openDatabase(join(directory, "test.db"));
  const asyncDatabase = createClient({ url: pathToFileURL(join(directory, "test.db")).href });
  let time = Date.parse("2026-11-07T00:00:00Z");
  const clock = () => time;
  const spaces = new Map<string, Codespace>();
  const calls: string[] = [];
  const outgoing: OutgoingEvent[] = [];
  const failures = new Map<string, number>();
  for (const id of [1, 2]) database.prepare(`INSERT INTO users
    (id, github_id, login, token_cipher, token_scopes, created_at, last_seen_at)
    VALUES (?, ?, 'fixture', ?, 'codespace', '2026-11-01', '2026-11-01')`).run(id, id, Buffer.from("fixture"));
  const github = createGitHubClient({ database: asyncDatabase, accessToken: async id => `synthetic-${id}`, fetch: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/user/codespaces") return Response.json({ codespaces: [...spaces.values(),
      { id: 999, name: "foreign-unregistered", state: "Available", machine: { name: "fixture", cpus: 64 } }] });
    const name = path.split("/")[3]!;
    const space = spaces.get(name);
    assert.ok(space, `Unexpected codespace ${name}`);
    if (init?.method === "POST") {
      calls.push(path);
      const status = failures.get(name);
      if (status) return Response.json({ message: "Synthetic refusal" }, { status });
      if (path.endsWith("/start")) { space.state = "Starting"; return Response.json(space); }
      assert.ok(path.endsWith("/stop"));
      // GitHub reports ShuttingDown until the test confirms shutdown. An Available reply after
      // the stop grace now means an external restart (issue #15), so it must not stand in here.
      space.state = "ShuttingDown";
      return new Response(null, { status: 202 });
    }
    return Response.json(space);
  } });
  const emit = (event: OutgoingEvent) => { outgoing.push(event); };
  const service = createPhoneService({ database: asyncDatabase, github, clock, emit, encrypt: value => Buffer.from(value) });
  const makeTick = () => createStatePoller({ database: asyncDatabase, clock, emit, sync: service.sync, autoStop: service.autoStop });
  return {
    asyncDatabase, database, spaces, calls, outgoing, failures, service, clock, makeTick,
    setTime(value: string) { time = Date.parse(value); }, advance(ms: number) { time += ms; },
    add(id = "phone-aaaa", userId = 1) {
      const name = `generated-${id}`;
      database.prepare(`INSERT INTO phones (id, user_id, codespace_name, repo_full_name, machine, cores,
        state, created_at, last_started_at, idle_timeout_min)
        VALUES (?, ?, ?, 'fixture/template', 'fixture', 2, 'running', ?, ?, 30)`)
        .run(id, userId, name, new Date(time).toISOString(), new Date(time).toISOString());
      spaces.set(name, { id: spaces.size + 1, name, state: "Available", machine: { name: "fixture", cpus: 2 } });
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

test("hours.low emits each threshold once per UTC month, survives a new poller, and never stops without opt-in", async () => {
  const f = fixture();
  try {
    f.add();
    await updateSettings(f.asyncDatabase, 1, { allowance_core_hours: 10 });
    const tick = f.makeTick();
    await tick();
    f.advance(4 * 3_600_000); // 8 used, 20% left, 60 minutes at 2 cores.
    await tick();
    await f.makeTick()();
    assert.deepEqual(f.outgoing.filter(e => e.type === "hours.low").map(e => e.data.threshold), ["20%"]);
    f.advance(30 * 60_000); // 9 used, 10% left, exactly 30 minutes.
    await tick();
    await f.makeTick()();
    assert.deepEqual(f.outgoing.filter(e => e.type === "hours.low").map(e => e.data.threshold), ["20%", "10%", "30min"]);
    assert.equal(f.calls.length, 0);
    const usage = await readUsage(f.asyncDatabase, 1, f.clock);
    assert.equal(hoursWarning(usage, false), "About 30 minutes of hours left. Stopping keeps your phones.");
    assert.match(hoursWarning(usage, true)!, /next tick/);
    f.setTime("2026-12-01T00:00:00Z");
    await tick();
    assert.equal(hoursWarning(await readUsage(f.asyncDatabase, 1, f.clock), false), null);
    f.advance(4.5 * 3_600_000);
    await tick();
    assert.equal(f.outgoing.filter(e => e.type === "hours.low").length, 6);
    assert.equal(f.outgoing.at(-1)?.data.month, "2026-12");
    assert.ok(!JSON.stringify(f.outgoing).includes("secret-fixture"));
  } finally { await f.close(); }
});

test("enabling auto-stop below the boundary stops only owned phones once, preserves the phone, and permits resuming later", async () => {
  const f = fixture();
  try {
    f.add(); f.add("phone-bbbb", 2);
    await updateSettings(f.asyncDatabase, 1, { allowance_core_hours: 1 });
    const tick = f.makeTick();
    await tick(); // Already 30 minutes remaining, but not opted in.
    assert.equal(f.calls.length, 0);
    await updateSettings(f.asyncDatabase, 1, { auto_stop_before_empty: true });
    const before = f.database.prepare("SELECT codespace_name FROM phones WHERE id = 'phone-aaaa'").get();
    await tick();
    await f.makeTick()(); // Available can remain stale after stop returns 202.
    assert.deepEqual(f.calls, ["/user/codespaces/generated-phone-aaaa/stop"]);
    assert.equal(f.database.prepare("SELECT state FROM phones WHERE id = 'phone-bbbb'").get()?.state, "running");
    assert.equal(f.outgoing.filter(e => e.type === "hours.auto_stopped").length, 1);
    assert.equal((await unreadAutoStops(f.asyncDatabase, 1)).length, 1);
    const notices = (await unreadAutoStops(f.asyncDatabase, 1));
    await acknowledgeAutoStops(f.asyncDatabase, 2, notices.map(n => n.id));
    assert.equal((await unreadAutoStops(f.asyncDatabase, 1)).length, 1);
    await acknowledgeAutoStops(f.asyncDatabase, 1, notices.map(n => n.id));
    await acknowledgeAutoStops(f.asyncDatabase, 1, notices.map(n => n.id));
    assert.deepEqual((await unreadAutoStops(f.asyncDatabase, 1)), []);
    f.advance(60_000);
    f.spaces.get("generated-phone-aaaa")!.state = "Shutdown";
    await tick();
    assert.deepEqual((await readUsage(f.asyncDatabase, 1, f.clock)).running, []);
    assert.equal(f.outgoing.filter(e => e.type === "phone.stopped").length, 1);
    await updateSettings(f.asyncDatabase, 1, { allowance_core_hours: 120 });
    await f.service.start(1, "phone-aaaa");
    await tick();
    assert.equal((await readUsage(f.asyncDatabase, 1, f.clock)).running.length, 1);
    assert.deepEqual(f.database.prepare("SELECT codespace_name FROM phones WHERE id = 'phone-aaaa'").get(), before);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM runs WHERE phone_id = 'phone-aaaa'").get()?.n, 2);
  } finally { await f.close(); }
});

test("auto-stop retries failed phones, skips accepted phones, and backs off rate limits without blocking another account", async () => {
  const f = fixture();
  try {
    for (const id of ["phone-aaaa", "phone-bbbb", "phone-cccc"]) f.add(id);
    f.add("phone-dddd", 2);
    for (const user of [1, 2]) await updateSettings(f.asyncDatabase, user, { allowance_core_hours: 1, auto_stop_before_empty: true });
    f.failures.set("generated-phone-aaaa", 500);
    f.failures.set("generated-phone-bbbb", 429);
    const tick = f.makeTick();
    await tick();
    assert.deepEqual(f.calls, ["/user/codespaces/generated-phone-aaaa/stop", "/user/codespaces/generated-phone-bbbb/stop", "/user/codespaces/generated-phone-dddd/stop"]);
    assert.equal((await unreadAutoStops(f.asyncDatabase, 1)).length, 0);
    f.failures.clear();
    f.advance(299_999);
    await tick();
    assert.equal(f.calls.length, 3);
    f.advance(1);
    await tick();
    assert.equal(f.calls.length, 6);
    assert.equal((await unreadAutoStops(f.asyncDatabase, 1)).length, 1, "one toast for one auto-stop run");
    await tick();
    assert.equal(f.calls.length, 6);
  } finally { await f.close(); }
});

test("auto-stop can protect more than six phones in one tick without the interactive mutation limit", async () => {
  const f = fixture();
  try {
    for (let n = 0; n < 8; n++) f.add(`phone-000${n}`);
    f.spaces.get("generated-phone-0000")!.state = "Provisioning";
    await updateSettings(f.asyncDatabase, 1, { allowance_core_hours: 1, auto_stop_before_empty: true });
    await f.makeTick()();
    assert.equal(f.calls.length, 8);
    assert.equal((await unreadAutoStops(f.asyncDatabase, 1)).length, 1, "one toast for one auto-stop run");
    await f.makeTick()();
    assert.equal(f.calls.length, 8);
  } finally { await f.close(); }
});
