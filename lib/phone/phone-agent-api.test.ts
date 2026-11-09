import { test } from "node:test";
import assert from "node:assert/strict";
import { createPhoneAgentApi } from "./phone-agent-api.ts";
import { PhoneInputError } from "./phone-mutations.ts";

const stored = { id: "phone-quiet-falcon", name: "Quiet Falcon", state: "running", android_state: "ready", idle_timeout_min: 240 };

function fixture(overrides: Partial<Parameters<typeof createPhoneAgentApi>[0]> = {}) {
  const calls: string[] = [];
  const api = createPhoneAgentApi({
    user: async () => ({ id: 7, authKind: "session" }),
    phones: async userId => { calls.push(`phones:${userId}`); return [stored]; },
    phone: async (userId, id) => { calls.push(`phone:${userId}:${id}`); return id === stored.id ? stored : undefined; },
    service: {
      start: async (userId, id) => { calls.push(`start:${userId}:${id}`); return id; },
      stop: async (userId, id) => { calls.push(`stop:${userId}:${id}`); return id; },
    },
    adb: async (userId, id) => { calls.push(`adb:${userId}:${id}`); return Response.json({ exit_code: 0, stdout: "", stderr: "" }); },
    baseUrl: () => "https://emuly.test/",
    ...overrides,
  });
  return { api, calls };
}

const get = (path = "/v1/phones") => new Request(`https://emuly.test${path}`);
const post = (path: string, body?: unknown, headers: Record<string, string> = {}) => new Request(`https://emuly.test${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("phone list and read require authentication, scope to the caller and build browser links", async () => {
  let signedIn = false;
  const { api, calls } = fixture({ user: async () => signedIn ? { id: 7, authKind: "session" } : null });
  assert.equal((await api.list()).status, 401);
  signedIn = true;

  const list = await api.list();
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await list.json(), { phones: [{
    id: stored.id, name: stored.name, state: "running", android_state: "ready", idle_timeout_min: 240,
    browser_url: `https://emuly.test/app/phones/${stored.id}`,
  }] });

  const one = await api.read(get(`/v1/phones/${stored.id}`), stored.id);
  assert.equal(one.status, 200);
  assert.equal((await one.json()).browser_url, `https://emuly.test/app/phones/${stored.id}`);
  assert.equal((await api.read(get("/v1/phones/phone-other"), "phone-other")).status, 404);
  assert.deepEqual(calls, [`phones:7`, `phone:7:${stored.id}`, "phone:7:phone-other"]);
});

test("start and stop allow agent keys without Origin but reject origin-less cookie requests", async () => {
  const { api, calls } = fixture({ user: async () => ({ id: 7, authKind: "agent", agentKeyId: 42 }) });
  const started = await api.start(post(`/v1/phones/${stored.id}/start`), stored.id);
  assert.equal(started.status, 202);
  assert.deepEqual(await started.json(), { id: stored.id, status: "starting" });
  assert.deepEqual(calls, [`start:7:${stored.id}`]);

  const stopped = await api.stop(post(`/v1/phones/${stored.id}/stop`, undefined, { origin: "https://emuly.test" }), stored.id);
  assert.equal(stopped.status, 202);
  assert.deepEqual(await stopped.json(), { id: stored.id, status: "stopping" });

  const cookie = fixture({ user: async () => ({ id: 7, authKind: "session" }) });
  assert.equal((await cookie.api.start(post(`/v1/phones/${stored.id}/start`), stored.id)).status, 403);
  assert.deepEqual(cookie.calls, [], "a cookie request without Origin never reaches the service");

  const foreign = fixture({ user: async () => ({ id: 7, authKind: "agent" }) });
  assert.equal((await foreign.api.stop(post(`/v1/phones/${stored.id}/stop`, undefined, { origin: "https://other.test" }), stored.id)).status, 403);
  assert.equal((await foreign.api.start(post(`/v1/phones/${stored.id}/start`, undefined, {
    origin: "https://emuly.test", "sec-fetch-site": "cross-site" }), stored.id)).status, 403);
  assert.deepEqual(foreign.calls, []);
});

test("lifecycle errors keep the existing status mapping", async () => {
  const { api } = fixture({ service: {
    start: async () => { throw new PhoneInputError("Keep it is in progress."); },
    stop: async () => { throw new Error("tunnel closed"); },
  } });
  assert.equal((await api.start(post(`/v1/phones/${stored.id}/start`, undefined, { origin: "https://emuly.test" }), stored.id)).status, 400);
  assert.equal((await api.stop(post(`/v1/phones/${stored.id}/stop`, undefined, { origin: "https://emuly.test" }), stored.id)).status, 502);
});

test("adb requires a ready phone and the same Origin rule as the other routes", async () => {
  const { api, calls } = fixture();
  const stoppedCalls: string[] = [];
  const stopped = fixture({ phone: async (userId, id) => {
    stoppedCalls.push(`phone:${userId}:${id}`);
    return { ...stored, state: "stopped", android_state: "idle" };
  } });
  const response = await stopped.api.adb(post(`/v1/phones/${stored.id}/adb`, { args: ["shell", "input", "tap", "1", "2"] }, {
    origin: "https://emuly.test" }), stored.id);
  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /Start it with POST \/v1\/phones\/phone-quiet-falcon\/start/);
  assert.deepEqual(stoppedCalls, [`phone:7:${stored.id}`]);

  const cookie = await api.adb(post(`/v1/phones/${stored.id}/adb`, { args: ["shell", "input", "tap", "1", "2"] }), stored.id);
  assert.equal(cookie.status, 403);
  assert.deepEqual(calls, [], "cookie requests without Origin never reach the phone or runner");

  const agent = fixture({ user: async () => ({ id: 7, authKind: "agent", agentKeyId: 42 }) });
  const run = await agent.api.adb(post(`/v1/phones/${stored.id}/adb`, { args: ["shell", "input", "tap", "1", "2"], timeout_s: 15 }), stored.id);
  assert.equal(run.status, 200);
  assert.deepEqual(await run.json(), { exit_code: 0, stdout: "", stderr: "" });
  assert.deepEqual(agent.calls, [`phone:7:${stored.id}`, `adb:7:${stored.id}`]);
});

test("adb validates args before the runner and returns raw PNG for screenshots", async () => {
  const runnerCalls: { args: string[]; timeout_s: number; binary?: boolean }[] = [];
  const logCalls: { args: string[]; exitCode: number; agentKeyId?: number }[] = [];
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const { api } = fixture({
    user: async () => ({ id: 7, authKind: "agent", agentKeyId: 42 }),
    adb: async (_userId, _id, input) => {
      runnerCalls.push(input);
      return input.binary ? new Response(png, { headers: { "content-type": "image/png" } })
        : Response.json({ exit_code: 1, stdout: "", stderr: "no device" });
    },
    log: call => { logCalls.push({ args: call.args, exitCode: call.exitCode, agentKeyId: call.agentKeyId }); },
  });

  const invalid = await api.adb(post(`/v1/phones/${stored.id}/adb`, { args: ["-s", "other", "shell", "id"] }, {
    origin: "https://emuly.test" }), stored.id);
  assert.equal(invalid.status, 400);
  assert.deepEqual(runnerCalls, [], "invalid args never reach the runner");

  const shot = await api.adb(post(`/v1/phones/${stored.id}/adb`, { args: ["exec-out", "screencap", "-p"] }, {
    origin: "https://emuly.test" }), stored.id);
  assert.equal(shot.status, 200);
  assert.equal(shot.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await shot.arrayBuffer()), png);
  assert.deepEqual(runnerCalls[0], { args: ["exec-out", "screencap", "-p"], timeout_s: 30, binary: true });
  assert.deepEqual(logCalls[0], { args: ["exec-out", "screencap", "-p"], exitCode: 0, agentKeyId: 42 });

  const failure = await api.adb(post(`/v1/phones/${stored.id}/adb`, { args: ["shell", "id"], timeout_s: 5 }, {
    origin: "https://emuly.test" }), stored.id);
  assert.equal(failure.status, 200);
  assert.deepEqual(await failure.json(), { exit_code: 1, stdout: "", stderr: "no device" });
  assert.deepEqual(runnerCalls[1], { args: ["shell", "id"], timeout_s: 5, binary: false });
  assert.deepEqual(logCalls[1], { args: ["shell", "id"], exitCode: 1, agentKeyId: 42 });
});
