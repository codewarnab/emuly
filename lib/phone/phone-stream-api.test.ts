import { test } from "node:test";
import assert from "node:assert/strict";
import { createPhoneStreamApi } from "./phone-stream-api.ts";
import { takeStreamTicket } from "./phone-stream-ticket.ts";

test("ticket issuance enforces session, origin, ownership and readiness without opening the runner", async () => {
  let identity: { id: number; sessionId: string } | null = null;
  let state = "running", android_state = "ready", opens = 0;
  const api = createPhoneStreamApi({ user: async () => identity,
    phone: (user, id) => user === 7 && id === "owned" ? { state, android_state } : undefined,
    open: async (user, id, session) => {
      assert.equal(user, 7); assert.equal(id, "owned"); assert.equal(session, "synthetic-hash"); opens++;
      throw new Error("revoked session or unavailable phone");
    } });
  const request = (origin = "https://phone.test") => new Request("https://phone.test/app/phones/owned/stream-ticket", {
    method: "POST", headers: { origin, cookie: "session=synthetic" } });
  assert.equal((await api(request(), "owned")).status, 401);
  identity = { id: 8, sessionId: "synthetic-hash" };
  assert.equal((await api(request(), "owned")).status, 404);
  identity.id = 7; state = "stopped";
  const stopped = await api(request(), "owned");
  assert.equal(stopped.status, 409);
  assert.deepEqual(await stopped.json(), { errorCode: "phone_stopped" });
  state = "running"; android_state = "booting";
  const booting = await api(request(), "owned");
  assert.equal(booting.status, 409);
  assert.equal(await booting.text(), "");
  android_state = "ready";
  assert.equal((await api(request("https://evil.test"), "owned")).status, 403);
  const response = await api(request(), "owned");
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(opens, 0);
  const body = await response.json(); assert.deepEqual(Object.keys(body), ["ticket"]);
  const ticket = takeStreamTicket(body.ticket, "owned", "https://phone.test", "session=synthetic");
  await assert.rejects(ticket!.open(), /revoked session/); assert.equal(opens, 1);
});
