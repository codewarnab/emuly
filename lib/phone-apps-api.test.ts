import { test } from "node:test";
import assert from "node:assert/strict";
import { createPhoneAppsApi } from "./phone-apps-api.ts";

const request = (method: string, body?: string, origin = "https://phonelink.test") => new Request("https://phonelink.test/v1/phones/one/apps", {
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
  const input = new Request("https://phonelink.test/upload", { method: "PUT", headers: { origin: "https://phonelink.test", "content-type": "application/octet-stream", "x-upload-offset": "0", "x-chunk-sha256": "0".repeat(64) }, body, duplex: "half" } as RequestInit);
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
