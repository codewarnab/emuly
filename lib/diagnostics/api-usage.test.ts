import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../data/async-database.ts";
import { migrateHosted } from "../data/hosted-migrations.ts";
import { apiUsageReport, authOf, clientOf, createApiUsage, routeTemplate } from "./api-usage.ts";

const PHONE = "phone-private-otter", KEY = "Bearer emk_private_secret";

async function fixture() {
  const database = createClient({ url: "file::memory:" });
  await migrateHosted(database);
  return { database, usage: createApiUsage(() => database) };
}

test("paths become route templates, never real ids", () => {
  assert.equal(routeTemplate("POST", `/v1/phones/${PHONE}/adb`), "POST /v1/phones/{id}/adb");
  assert.equal(routeTemplate("GET", `/v1/phones/${PHONE}/recording/grid`), "GET /v1/phones/{id}/recording/{status|file|grid|notes}");
  assert.equal(routeTemplate("GET", "/v1/phones"), "GET /v1/phones");
  assert.equal(routeTemplate("GET", `/v1/nope/${PHONE}`), "GET unknown");
});

test("client and auth come from headers only", () => {
  assert.deepEqual(clientOf(new Headers({ "x-emuly-client": "cli" })), { client: "cli", version: "unknown" });
  assert.deepEqual(clientOf(new Headers({ "x-emuly-client": "cli/ab12cd3" })), { client: "cli", version: "ab12cd3" });
  assert.deepEqual(clientOf(new Headers({ "x-emuly-client": "cli/not-hex" })), { client: "cli", version: "unknown" });
  assert.deepEqual(clientOf(new Headers({ "x-emuly-skill": "2026-11-25.2" })), { client: "skill", version: "2026-11-25.2" });
  assert.deepEqual(clientOf(new Headers({ "x-emuly-skill": "private text" })), { client: "skill", version: "unknown" });
  assert.equal(clientOf(new Headers({ "user-agent": "curl/8.4.0" })).client, "curl");
  assert.equal(authOf(new Headers({ authorization: KEY })), "agent_key");
  assert.equal(authOf(new Headers({ cookie: "__Host-emuly_session=abc" })), "session");
  assert.equal(authOf(new Headers()), "none");
});

test("counts are anonymous: no id, key, path or time of day is stored", async () => {
  const { database, usage } = await fixture();
  try {
    const headers = new Headers({ authorization: KEY, "x-emuly-client": "cli", "x-forwarded-for": "203.0.113.7" });
    for (let i = 0; i < 3; i++) usage.record({ method: "POST", pathname: `/v1/phones/${PHONE}/adb`, headers, status: 200, durationMs: 300 }, "caller-a");
    usage.record({ method: "POST", pathname: `/v1/phones/${PHONE}/adb`, headers, status: 409, durationMs: 5, error: "busy" }, "caller-a");
    usage.record({ method: "POST", pathname: `/v1/phones/${PHONE}/adb`, headers, status: 400, durationMs: 5, error: "free text from /home/me" }, "caller-a");
    await usage.settled();
    const rows = (await database.execute("SELECT * FROM diagnostic_api ORDER BY samples DESC")).rows;
    assert.equal(rows[0]!.samples, 3);
    assert.equal(rows[0]!.bucket_ms, 512);
    assert.deepEqual(rows.map(r => r.error_code).sort(), ["busy", "none", "other"]);
    const text = JSON.stringify(rows) + JSON.stringify((await database.execute("SELECT * FROM diagnostic_api_patterns")).rows);
    for (const secret of [PHONE, "emk_private_secret", "203.0.113.7", "caller-a", "/home/me", "T"]) {
      if (secret === "T") assert.ok(!/\d\dT\d\d:/.test(text), "time of day stored");
      else assert.ok(!text.includes(secret), `${secret} stored`);
    }
  } finally { database.close(); }
});

test("patterns: retry after failure, poll after a waiting call, screenshot burst, unknown route", async () => {
  const { database, usage } = await fixture();
  try {
    const headers = new Headers({ authorization: KEY });
    const at = (now: number, method: string, pathname: string, status = 200) => usage.record({ method, pathname, headers, status, durationMs: 1, now }, "caller-b");
    at(0, "POST", `/v1/phones/${PHONE}/adb`, 409); at(1_000, "POST", `/v1/phones/${PHONE}/adb`);
    at(2_000, "POST", `/v1/phones/${PHONE}/start`); at(2_500, "GET", `/v1/phones/${PHONE}`);
    for (let i = 0; i < 11; i++) at(10_000 + i * 100, "GET", `/v1/phones/${PHONE}/screenshot`);
    at(20_000, "GET", "/v1/wrong");
    await usage.settled();
    const found = Object.fromEntries((await database.execute("SELECT pattern, samples FROM diagnostic_api_patterns")).rows.map(r => [r.pattern, r.samples]));
    assert.deepEqual(found, { retry_same_route: 1, poll_after_wait: 1, screenshot_burst: 1, unknown_route: 1 });
  } finally { database.close(); }
});

test("reports hide groups with fewer than 10 samples", async () => {
  const { database, usage } = await fixture();
  try {
    const headers = new Headers({ authorization: KEY });
    for (let i = 0; i < 12; i++) usage.record({ method: "GET", pathname: "/v1/phones", headers, status: 200, durationMs: 100 });
    for (let i = 0; i < 9; i++) usage.record({ method: "GET", pathname: "/v1/me", headers, status: 200, durationMs: 100 });
    await usage.settled();
    const report = await apiUsageReport(database);
    assert.deepEqual(report.routes.map(r => [r.route, r.samples, r.p50Ms]), [["GET /v1/phones", 12, 128]]);
  } finally { database.close(); }
});

test("a slow or broken database never slows or breaks a request", async () => {
  const usage = createApiUsage(() => ({ batch: () => new Promise((_, reject) => setTimeout(() => reject(new Error("down")), 300)) }) as never);
  const started = performance.now();
  for (let i = 0; i < 100; i++) usage.record({ method: "GET", pathname: "/v1/phones", headers: new Headers(), status: 200, durationMs: 1 });
  assert.ok(performance.now() - started < 50);
  await usage.settled();
});
