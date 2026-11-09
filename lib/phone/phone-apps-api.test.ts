import { test } from "node:test";
import assert from "node:assert/strict";
import { createPhoneAppsApi } from "./phone-apps-api.ts";

const request = (method: string, body?: string, origin = "https://emuly.test") => new Request("https://emuly.test/v1/phones/one/apps", {
  method, headers: { origin, "content-type": "application/json" }, ...(body ? { body } : {}),
});
test("Apps rejects unauthenticated, foreign-owner, stopped and cross-origin requests before runner access", async () => {
  for (const scenario of ["anonymous", "foreign", "stopped", "cross-site"]) {
    let reached = false;
    const api = createPhoneAppsApi({ user: async () => scenario === "anonymous" ? null : { id: 1 },
      phone: () => scenario === "foreign" ? undefined : { state: scenario === "stopped" ? "stopped" : "running", android_state: "ready" },
      runner: async () => { reached = true; return Response.json({}); } });
    const result = await api(request("POST", JSON.stringify({ packageId: "com.example.app" }), scenario === "cross-site" ? "https://other.test" : undefined), "one", ["apps", "open"]);
    assert.equal(result.status, ({ anonymous: 401, foreign: 404, stopped: 409, "cross-site": 403 })[scenario]);
    assert.equal(reached, false);
  }
});
test("Apps rejects oversized streaming chunks even without Content-Length", async () => {
  let reached = false;
  const api = createPhoneAppsApi({ user: async () => ({ id: 8 }), phone: () => ({ state: "running", android_state: "ready" }),
    runner: async () => { reached = true; return Response.json({}); } });
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); controller.close(); } });
  const input = new Request("https://emuly.test/upload", { method: "PUT", headers: { origin: "https://emuly.test", "content-type": "application/octet-stream", "x-upload-offset": "0", "x-chunk-sha256": "0".repeat(64) }, body, duplex: "half" } as RequestInit);
  const response = await api(input, "one", ["app-installs", "11111111-1111-1111-1111-111111111111", "content"]);
  assert.equal(response.status, 413); assert.equal(reached, false);
});
test("Apps preserves runner conflicts and missing-operation errors and keeps responses private", async () => {
  for (const status of [409, 404]) {
  const api = createPhoneAppsApi({ user: async () => ({ id: 9 }), phone: () => ({ state: "running", android_state: "ready" }),
    runner: async () => Response.json({ error: "Operation error", errorCode: status === 409 ? "offset_conflict" : "not_found" }, { status }) });
  const response = await api(request("POST"), "one", ["app-installs", "11111111-1111-1111-1111-111111111111", "complete"]);
  assert.equal(response.status, status); assert.equal((await response.json()).errorCode, status === 409 ? "offset_conflict" : "not_found");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});

test("Apps validates success responses without changing valid records or status codes", async () => {
  const operation = { id: "11111111-1111-4111-8111-111111111111", source: "upload", filename: "app.apk",
    stage: "failed", bytesReceived: 10, totalBytes: 10, canCancel: false, errorCode: "install_failed", message: "Choose another APK." };
  const scenarios = [
    { route: ["apps"], method: "GET", payload: { apps: [{ packageId: "com.example.app", versionCode: null, launchable: false }], fetchedAt: "2026-11-08" }, status: 200 },
    { route: ["app-installs"], method: "GET", payload: { operations: [operation] }, status: 200 },
    { route: ["app-installs", operation.id], method: "GET", payload: operation, status: 200 },
    { route: ["app-installs"], method: "POST", payload: operation, status: 202 },
    { route: ["app-installs", operation.id, "complete"], method: "POST", payload: operation, status: 200 },
    { route: ["app-installs", operation.id, "cancel"], method: "POST", payload: { ...operation, stage: "cancelled" }, status: 200 },
    { route: ["apps", "open"], method: "POST", payload: { ok: true }, status: 200 },
  ];
  for (const scenario of scenarios) {
    const api = createPhoneAppsApi({ user: async () => ({ id: 51 }), phone: () => ({ state: "running", android_state: "ready" }),
      runner: async () => Response.json(scenario.payload) });
    const body = scenario.route.join("/") === "apps/open" ? { packageId: "com.example.app" }
      : { source: "upload", key: "11111111-1111-4111-8111-111111111111", filename: "app.apk", totalBytes: 10 };
    const response = await api(request(scenario.method, scenario.method === "POST" ? JSON.stringify(body) : undefined), "one", scenario.route);
    assert.equal(response.status, scenario.status);
    assert.deepEqual(await response.json(), scenario.payload);
  }
});

test("Apps returns safe 502 errors for malformed runner successes, errors, and JSON", async () => {
  const scenarios = [
    { route: ["apps"], body: JSON.stringify({ apps: [null] }), status: 200 },
    { route: ["app-installs"], body: JSON.stringify({ operations: [{}] }), status: 200 },
    { route: ["app-installs", "11111111-1111-4111-8111-111111111111"], body: "null", status: 200 },
    { route: ["apps"], body: JSON.stringify({ error: { private: "sensitive detail" } }), status: 503 },
    { route: ["apps"], body: "sensitive non-JSON detail", status: 200 },
  ];
  for (const scenario of scenarios) {
    const api = createPhoneAppsApi({ user: async () => ({ id: 52 }), phone: () => ({ state: "running", android_state: "ready" }),
      runner: async () => new Response(scenario.body, { status: scenario.status }) });
    const response = await api(request("GET"), "one", scenario.route);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Invalid phone response. Refresh status before retrying.", errorCode: "invalid_response" });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});

test("Apps gives an account admission back when the runner never accepts the operation", async () => {
  const calls: string[] = [];
  const key = "11111111-1111-4111-8111-111111111111";
  const api = createPhoneAppsApi({ user: async () => ({ id: 61 }), phone: () => ({ state: "running", android_state: "ready" }),
    runner: async () => { throw new Error("tunnel closed"); },
    sharedAdmission: { current: async () => undefined,
      claim: async () => { calls.push("claim"); return true; },
      release: async (_userId: number, _phoneId: string, operation: string) => { calls.push(`release:${operation}`); } } });
  const response = await api(request("POST", JSON.stringify({ source: "url", key, url: "https://example.com/app.apk" })), "one", ["app-installs"]);
  assert.equal(response.status, 502);
  assert.deepEqual(calls, ["claim", `release:${key}`]);
});

test("Apps lets origin-less agent keys through but rejects origin-less cookie sessions", async () => {
  const make = (method: string) => new Request("https://emuly.test/v1/phones/one/apps/open", { method,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ packageId: "com.example.app" }) });
  for (const [authKind, expected] of [["agent", 200], ["session", 403]] as const) {
    let reached = false;
    const api = createPhoneAppsApi({ user: async () => ({ id: 1, authKind }),
      phone: () => ({ state: "running", android_state: "ready" }),
      runner: async () => { reached = true; return Response.json({ ok: true }); } });
    const response = await api(make("POST"), "one", ["apps", "open"]);
    assert.equal(response.status, expected);
    assert.equal(reached, authKind === "agent");
  }
});

test("Apps checks update and launch acknowledgements before reporting success", async () => {
  for (const valid of [true, false]) {
    const api = createPhoneAppsApi({ user: async () => ({ id: 53 }), phone: () => ({ state: "running", android_state: "ready" }),
      runner: async () => Response.json({ ok: valid ? true : "true" }), upgrade: async () => ({ status: valid ? "working" : "unknown" }) });
    const open = await api(request("POST", JSON.stringify({ packageId: "com.example.app" })), "one", ["apps", "open"]);
    const update = await api(request("POST"), "one", ["apps", "update"]);
    assert.equal(open.status, valid ? 200 : 502);
    assert.equal(update.status, valid ? 200 : 502);
  }
});
