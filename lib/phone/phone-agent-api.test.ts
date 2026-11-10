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
    agentDevice: async (userId, id) => { calls.push(`agent:${userId}:${id}`); return { ready: true, token: "proxy-token", version: "0.21.36" }; },
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
const multipart = (path: string, args: unknown, files: { name: string; body: string }[] = [],
  extra: Record<string, string> = {}) => {
  const form = new FormData();
  form.set("args", JSON.stringify(args));
  for (const [index, file] of files.entries()) form.set(`file${index}`, new File([file.body], file.name));
  return new Request(`https://emuly.test${path}`, { method: "POST", body: form, headers: { origin: "https://emuly.test", ...extra } });
};

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

test("agent-device returns the proxy URL only for the owner's running, ready phone", async () => {
  const { api, calls } = fixture({ user: async () => ({ id: 7, authKind: "agent", agentKeyId: 42 }) });
  const response = await api.agentDevice(get(`/v1/phones/${stored.id}/agent-device`), stored.id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    base_url: `https://emuly.test/v1/phones/${stored.id}/agent-device-proxy/agent-device`,
    token: "proxy-token", version: "0.21.36", session: `emuly-${stored.id}`,
  });
  assert.deepEqual(calls, [`phone:7:${stored.id}`, `agent:7:${stored.id}`]);

  const anonymous = fixture({ user: async () => null });
  assert.equal((await anonymous.api.agentDevice(get(`/v1/phones/${stored.id}/agent-device`), stored.id)).status, 401);
  assert.deepEqual(anonymous.calls, [], "authentication comes before any phone lookup");

  const cookie = fixture({ user: async () => ({ id: 7, authKind: "session" }) });
  assert.equal((await cookie.api.agentDevice(get(`/v1/phones/${stored.id}/agent-device`), stored.id)).status, 403);
  assert.deepEqual(cookie.calls, [], "an origin-less cookie request is cross-site");
});

test("agent-device hides every unavailable reason behind one 404", async () => {
  const expected = { error: "agent-device is not available on this phone" };
  const agent = async () => ({ id: 7, authKind: "agent" as const, agentKeyId: 42 });
  const stopped = fixture({ user: agent, phone: async () => ({ ...stored, state: "stopped", android_state: "idle" }) });
  const waiting = fixture({ user: agent, agentDevice: async () => ({ ready: false, token: "proxy-token" }) });
  const failed = fixture({ user: agent, agentDevice: async () => { throw new Error("runner route missing"); } });
  const notOwner = fixture({ user: agent, phone: async () => undefined });
  for (const { api } of [stopped, waiting, failed, notOwner]) {
    const response = await api.agentDevice(get(`/v1/phones/${stored.id}/agent-device`), stored.id);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), expected);
  }
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

test("multipart adb passes uploaded bytes and rejects missing or unreferenced files", async () => {
  const runnerCalls: { args: string[]; timeout_s: number; binary?: boolean; files?: { name: string; bytes: Uint8Array }[] }[] = [];
  const { api } = fixture({
    user: async () => ({ id: 7, authKind: "agent", agentKeyId: 42 }),
    adb: async (_userId, _id, input) => {
      runnerCalls.push(input);
      return Response.json({ exit_code: 0, stdout: "Success", stderr: "" });
    },
  });
  const installed = await api.adb(multipart(`/v1/phones/${stored.id}/adb`,
    ["install", "-r", "@file0"], [{ name: "app.apk", body: "apk-bytes" }]), stored.id);
  assert.equal(installed.status, 200);
  assert.equal(runnerCalls[0]?.args[0], "install");
  assert.equal(runnerCalls[0]?.files?.length, 1);
  assert.equal(runnerCalls[0]?.files?.[0]?.name, "app.apk");
  assert.equal(Buffer.from(runnerCalls[0]!.files![0]!.bytes).toString(), "apk-bytes");
  assert.equal(runnerCalls[0]?.timeout_s, 30);

  const missing = await api.adb(multipart(`/v1/phones/${stored.id}/adb`, ["install", "-r", "@file0"]), stored.id);
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).message, /not uploaded/);

  const unreferenced = await api.adb(multipart(`/v1/phones/${stored.id}/adb`, ["install", "-r", "@file0"],
    [{ name: "a.apk", body: "a" }, { name: "b.apk", body: "b" }]), stored.id);
  assert.equal(unreferenced.status, 400);
  assert.match((await unreferenced.json()).message, /file1 is not referenced/);
  assert.equal(runnerCalls.length, 1, "invalid multipart never reaches the runner");
});

test("pull and bugreport relay the runner's bytes and filename", async () => {
  const { api } = fixture({
    user: async () => ({ id: 7, authKind: "agent", agentKeyId: 42 }),
    adb: async (_userId, _id, input) => new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${input.args[0] === "pull" ? "x.png" : "bugreport.zip"}"` },
    }),
  });
  const pulled = await api.adb(post(`/v1/phones/${stored.id}/adb`, { args: ["pull", "/sdcard/x.png"] }, {
    origin: "https://emuly.test" }), stored.id);
  assert.equal(pulled.status, 200);
  assert.equal(pulled.headers.get("content-type"), "application/octet-stream");
  assert.equal(pulled.headers.get("content-disposition"), 'attachment; filename="x.png"');
  assert.deepEqual(new Uint8Array(await pulled.arrayBuffer()), new Uint8Array([1, 2, 3]));

  const bug = await api.adb(post(`/v1/phones/${stored.id}/adb`, { args: ["bugreport"], timeout_s: 300 }, {
    origin: "https://emuly.test" }), stored.id);
  assert.equal(bug.status, 200);
  assert.equal(bug.headers.get("content-disposition"), 'attachment; filename="bugreport.zip"');
});
