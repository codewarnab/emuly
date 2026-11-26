import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("the ticket, observation and direct steps start together, and a direct failure keeps the ticket", async () => {
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const step = async <T>(name: string, value: T) => { started.push(name); await gate; return value; };
  let directFails = false;
  const api = createPhoneStreamApi({ user: async () => ({ id: 7, sessionId: "synthetic-hash" }),
    phone: () => ({ state: "running", android_state: "ready", codespace_name: "cs" }),
    open: async () => { throw new Error("not used"); },
    issue: () => step("issue", "t1"),
    observation: () => step("observation", "a1"),
    direct: async () => { await step("direct", null); if (directFails) throw new Error("port not public"); return { url: "wss://cs-8791", ticket: "d1" }; } });
  const request = () => new Request("https://phone.test/app/phones/owned/stream-ticket", { method: "POST", headers: { origin: "https://phone.test" } });

  const pending = api(request(), "owned");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started.sort(), ["direct", "issue", "observation"], "all three steps started before any finished");
  release();
  assert.deepEqual(await (await pending).json(), { ticket: "t1", attemptId: "a1", direct: { url: "wss://cs-8791", ticket: "d1" } });

  directFails = true;
  const fallback = await api(request(), "owned");
  assert.equal(fallback.status, 200);
  assert.deepEqual(await fallback.json(), { ticket: "t1", attemptId: "a1" }, "the browser falls back to the Vercel ticket");
});

test("the stream-ticket route reads the session once", () => {
  const source = readFileSync("app/(app)/app/phones/[id]/stream-ticket/route.ts", "utf8");
  assert.doesNotMatch(source, /getUser/);
  assert.equal(source.match(/getSession\(\)/g)?.length, 1);
});
