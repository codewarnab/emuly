import { test } from "node:test";
import assert from "node:assert/strict";
import { createPhoneScreenApi } from "./phone-screen-api.ts";

test("screen routes enforce session, ownership, readiness, origin, and input bounds before runner access", async () => {
  let identity: { id: number } | null = null;
  let state = "running", android = "ready", calls = 0;
  const api = createPhoneScreenApi({ user: async () => identity,
    phone: (user, id) => user === 1 && id === "phone-aaaa" ? { state, android_state: android } : undefined,
    runner: async () => { calls++; return Response.json({ ok: true }); } });
  const request = (input: unknown, origin = "https://emuly.test") => new Request("https://emuly.test/app/phones/phone-aaaa/screen.png", {
    method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(input) });
  assert.equal((await api(request({}), "phone-aaaa")).status, 401);
  identity = { id: 2 };
  assert.equal((await api(request({}), "phone-aaaa")).status, 404);
  identity = { id: 1 };
  state = "stopped";
  assert.equal((await api(request({}), "phone-aaaa")).status, 409);
  state = "running"; android = "booting";
  assert.equal((await api(request({}), "phone-aaaa")).status, 409);
  android = "ready";
  assert.equal((await api(request({ type: "key", key: "home" }, "https://foreign.test"), "phone-aaaa")).status, 403);
  for (const input of [{ type: "tap", x: -1, y: 1 }, { type: "tap", x: 1.5, y: 1 }, { type: "key", key: "shell" }, null]) {
    assert.equal((await api(request(input), "phone-aaaa")).status, 400);
  }
  assert.equal((await api(request({ text: "x".repeat(2000) }), "phone-aaaa")).status, 413);
  assert.equal(calls, 0);
  assert.equal((await api(request({ type: "tap", x: 0, y: 10000 }), "phone-aaaa")).status, 200);
  assert.equal((await api(request({ type: "key", key: "back" }), "phone-aaaa")).status, 200);
  assert.equal(calls, 2);
});

test("screens return only PNG bytes with private no-store headers, and hide upstream errors", async () => {
  let invalid = false;
  const bytes = Buffer.from("89504e470d0a1a0a00000000", "hex");
  const api = createPhoneScreenApi({ user: async () => ({ id: 1 }),
    phone: () => ({ state: "running", android_state: "ready" }), runner: async () => {
      if (invalid) throw new Error("synthetic-private-token");
      return new Response(bytes, { headers: { "Content-Type": "image/png", "X-Github-Token": "synthetic-private-token" } });
    } });
  const request = new Request("https://emuly.test/screen.png");
  const response = await api(request, "phone-aaaa");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("X-Github-Token"), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  invalid = true;
  const failure = await api(request, "phone-aaaa");
  assert.equal(failure.status, 502);
  assert.doesNotMatch(await failure.text(), /synthetic-private-token/);
});
