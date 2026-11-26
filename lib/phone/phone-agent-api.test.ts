import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhoneAgentApi } from "./phone-agent-api.ts";
import { PhoneInputError } from "./phone-mutations.ts";
import { RunnerTimeoutError } from "./runner-errors.ts";
import { GitHubError } from "../github/github.ts";

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
    id: stored.id, name: stored.name, state: "running", android_state: "ready", idle_timeout_min: 240, idle_stop_at: null, device_preset: "generic", location: null,
    browser_url: `https://emuly.test/app/phones/${stored.id}`,
  }] });

  const one = await api.read(get(`/v1/phones/${stored.id}`), stored.id);
  assert.equal(one.status, 200);
  assert.equal((await one.json()).browser_url, `https://emuly.test/app/phones/${stored.id}`);
  assert.equal((await api.read(get("/v1/phones/phone-other"), "phone-other")).status, 404);
  assert.deepEqual(calls, [`phones:7`, `phone:7:${stored.id}`, "phone:7:phone-other"]);
});

test("a stop answers before Android saves, and wait_for holds a read until the phone stops", async () => {
  const phoneState = { ...stored };
  const { api, calls } = fixture({
    waitStepMs: 5,
    phone: async (_userId, id) => id === stored.id ? phoneState : undefined,
    service: {
      start: async (_u, id) => id,
      stop: async () => { throw new Error("the detached stop must be used"); },
      requestStop: async (userId, id) => { calls.push(`requestStop:${userId}:${id}`); return id; },
    },
  });
  const accepted = await api.stop(post(`/v1/phones/${stored.id}/stop`, undefined, { origin: "https://emuly.test" }), stored.id);
  assert.equal(accepted.status, 202);
  assert.deepEqual(calls, [`requestStop:7:${stored.id}`]);

  setTimeout(() => { phoneState.state = "stopped"; phoneState.android_state = "idle"; }, 30);
  const waited = await (await api.read(get(`/v1/phones/${stored.id}?wait_for=stopped&timeout_s=5`), stored.id)).json();
  assert.equal(waited.state, "stopped");
  assert.deepEqual(waited.wait, { for: "stopped", done: true, failed: false, timed_out: false });

  // A wait for ready ends at once when the phone is stopped: it cannot become ready by itself.
  const failed = await (await api.read(get(`/v1/phones/${stored.id}?wait_for=ready&timeout_s=5`), stored.id)).json();
  assert.deepEqual(failed.wait, { for: "ready", done: false, failed: true, timed_out: false });
  assert.equal((await api.read(get(`/v1/phones/${stored.id}?wait_for=gone`), stored.id)).status, 400);
  assert.equal((await api.read(get(`/v1/phones/${stored.id}?wait_for=stopped&timeout_s=999`), stored.id)).status, 400);
});

test("start and stop allow agent keys without Origin but reject origin-less cookie requests", async () => {
  const { api, calls } = fixture({ user: async () => ({ id: 7, authKind: "agent", agentKeyId: 42 }) });
  const started = await api.start(post(`/v1/phones/${stored.id}/start`), stored.id);
  assert.equal(started.status, 202);
  const startBody = await started.json();
  assert.equal(startBody.status, "starting");
  assert.equal(startBody.wait, `/v1/phones/${stored.id}?wait_for=ready&timeout_s=60`);
  assert.deepEqual(calls, [`start:7:${stored.id}`]);

  const stopped = await api.stop(post(`/v1/phones/${stored.id}/stop`, undefined, { origin: "https://emuly.test" }), stored.id);
  assert.equal(stopped.status, 202);
  const stopBody = await stopped.json();
  assert.equal(stopBody.status, "stopping");
  assert.equal(stopBody.wait, `/v1/phones/${stored.id}?wait_for=stopped&timeout_s=60`);

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

test("a large bugreport streams through instead of waiting for the whole file", async () => {
  let pulls = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const { api } = fixture({
    user: async () => ({ id: 7, authKind: "agent", agentKeyId: 42 }),
    adb: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; if (pulls > 20) controller.close(); else controller.enqueue(chunk); },
    }), { headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="bugreport.zip"' } }),
  });
  const bug = await api.adb(post(`/v1/phones/${stored.id}/adb`, { args: ["bugreport"], timeout_s: 300 }, {
    origin: "https://emuly.test" }), stored.id);
  assert.equal(bug.status, 200);
  assert.ok(pulls < 5, "the reply starts before the 20 MB file is read");
  assert.equal((await bug.arrayBuffer()).byteLength, 20 * 1024 * 1024);
});

test("the phone list carries a skill update hint only when the skill is not current", async () => {
  const { api } = fixture({ skillUpdate: request => request?.headers.get("x-emuly-skill") === "abcdefabcdef" ? null : { latest: "abcdefabcdef" } });
  const current = await (await api.list(new Request("https://emuly.test/v1/phones", { headers: { "X-Emuly-Skill": "abcdefabcdef" } }))).json();
  assert.equal(current.skill_update, undefined);
  const old = await (await api.list(new Request("https://emuly.test/v1/phones"))).json();
  assert.deepEqual(old.skill_update, { latest: "abcdefabcdef" });
  assert.equal(old.phones.length, 1);
});

test("the phone list carries the network hint only when the user's browser saw a blocked network", async () => {
  const hint = { code: "direct_port_blocked", message: "m", fix: [], sources: [] };
  const none = await (await fixture({ networkHint: async () => null }).api.list(new Request("https://emuly.test/v1/phones"))).json();
  assert.equal(none.network_hint, undefined);
  const blocked = await (await fixture({ networkHint: async () => hint }).api.list(new Request("https://emuly.test/v1/phones"))).json();
  assert.deepEqual(blocked.network_hint, hint);
  // A failed lookup never breaks the list.
  const broken = await fixture({ networkHint: async () => { throw new Error("db"); } }).api.list(new Request("https://emuly.test/v1/phones"));
  assert.equal(broken.status, 200);
});

test("recording routes check the method, pass only known options and stream the MP4", async () => {
  const sent: unknown[] = [];
  const { api } = fixture({
    user: async () => ({ id: 7, authKind: "agent" }),
    recording: async (_userId, _id, action, body) => {
      sent.push([action, body]);
      if (action === "file") return new Response(new Uint8Array([0, 0, 0, 24]), { headers: { "content-type": "video/mp4", "content-length": "4", "content-disposition": 'attachment; filename="a.mp4"' } });
      if (action === "stop") return Response.json({ error: "No recording exists. Start one first.", errorCode: "no_recording" }, { status: 404 });
      return Response.json({ state: "recording", id: "r1" });
    },
  });
  const path = `/v1/phones/${stored.id}/recording`;
  const started = await api.recording(post(`${path}/start`, { quality: "saver", max_s: 60, path: "/etc/passwd" }), stored.id, "start");
  assert.equal(started.status, 200);
  assert.deepEqual(sent[0], ["start", { quality: "saver", max_s: 60 }]);
  assert.equal((await api.recording(post(`${path}/start`), stored.id, "start")).status, 200);
  assert.deepEqual(sent[1], ["start", {}]);

  const wrong = await api.recording(get(`${path}/start`), stored.id, "start");
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("allow"), "POST");
  assert.equal((await api.recording(get(`${path}/constructor`), stored.id, "constructor")).status, 404);

  const missing = await api.recording(post(`${path}/stop`), stored.id, "stop");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "no_recording");

  const file = await api.recording(get(`${path}/file`), stored.id, "file");
  assert.equal(file.headers.get("content-type"), "video/mp4");
  assert.equal(file.headers.get("content-disposition"), 'attachment; filename="a.mp4"');
  assert.deepEqual(Array.from(new Uint8Array(await file.arrayBuffer())), [0, 0, 0, 24]);
});

test("recording mark passes only the text, and notes?format=vtt returns WebVTT", async () => {
  const sent: unknown[] = [];
  const { api } = fixture({
    user: async () => ({ id: 7, authKind: "agent" }),
    recording: async (_userId, _id, action, body) => {
      sent.push([action, body]);
      if (action === "notes") return Response.json({ state: "done", video_start_at: "2026-11-21T00:00:00.000Z", duration_ms: 3000,
        notes: [{ t_s: 1, text: "Tap Submit" }] });
      return Response.json({ t_s: 1, text: "Tap Submit" });
    },
  });
  const path = `/v1/phones/${stored.id}/recording`;
  assert.equal((await api.recording(post(`${path}/mark`, { text: "Tap Submit", t_s: 99 }), stored.id, "mark")).status, 200);
  assert.deepEqual(sent[0], ["mark", { text: "Tap Submit" }]);
  assert.equal((await api.recording(get(`${path}/mark`), stored.id, "mark")).status, 405);
  const json = await api.recording(get(`${path}/notes`), stored.id, "notes");
  assert.deepEqual((await json.json()).notes, [{ t_s: 1, text: "Tap Submit" }]);
  const vtt = await api.recording(get(`${path}/notes?format=vtt`), stored.id, "notes");
  assert.equal(vtt.headers.get("content-type"), "text/vtt; charset=utf-8");
  assert.equal(await vtt.text(), "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nTap Submit\n");
});

test("recording asks for a runner update when the runner has no recording routes", async () => {
  const { api } = fixture({ user: async () => ({ id: 7, authKind: "agent" }),
    recording: async () => Response.json({ error: "not found" }, { status: 404 }) });
  const response = await api.recording(get(`/v1/phones/${stored.id}/recording/status`), stored.id, "status");
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "runner_update_required");
});

test("recording start needs Android ready", async () => {
  const { api } = fixture({ user: async () => ({ id: 7, authKind: "agent" }),
    phone: async () => ({ ...stored, android_state: "booting" }), recording: async () => Response.json({}) });
  const response = await api.recording(post(`/v1/phones/${stored.id}/recording/start`), stored.id, "start");
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "phone_not_ready");
});

test("multipart adb over 4 MB answers JSON that names the limit and the upload route", async () => {
  const { api } = fixture();
  const big = multipart(`/v1/phones/${stored.id}/adb`, ["push", "@file0", "/sdcard/x"], [{ name: "x", body: "a".repeat(4 * 1024 * 1024 + 1) }]);
  const response = await api.adb(big, stored.id);
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error, "upload_too_large");
  assert.equal(body.limit_bytes, 4 * 1024 * 1024);
  assert.match(body.message, /adb\/upload/);
});

test("adb/upload checks the files and args, then returns a direct PUT with the ticket", async () => {
  const tickets: unknown[] = [];
  const { api } = fixture({ uploadTicket: async (userId, id, input) => { tickets.push({ userId, id, input });
    return { url: "https://space-8791.app.github.dev/adb", ticket: "t.sig", exp: 1_800_000_060_000 }; } });
  const path = `/v1/phones/${stored.id}/adb/upload`;
  const up = (body: unknown) => post(path, body, { origin: "https://emuly.test" });
  const file = { name: "a.apk", size: 50_000_000, sha256: "c".repeat(64) };
  const ok = await api.adbUpload(up({ args: ["install", "-r", "@file0"], files: [file] }), stored.id);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.url, "https://space-8791.app.github.dev/adb");
  assert.equal(body.method, "PUT");
  assert.equal(body.headers.Authorization, "Emuly-Ticket t.sig");
  assert.deepEqual(tickets, [{ userId: 7, id: stored.id, input: { args: ["install", "-r", "@file0"], timeout_s: 30, files: [file] } }]);

  assert.equal((await api.adbUpload(up({ args: ["shell", "ls"], files: [file] }), stored.id)).status, 400);
  assert.equal((await api.adbUpload(up({ args: ["install", "@file0"], files: [{ ...file, sha256: "x" }] }), stored.id)).status, 400);
  const huge = await api.adbUpload(up({ args: ["install", "@file0"], files: [{ ...file, size: 1024 * 1024 * 1024 + 1 }] }), stored.id);
  assert.equal(huge.status, 413);
  assert.equal((await api.adbUpload(up({ args: ["install", "@file0"], files: [file] }), "phone-other")).status, 404);
  assert.equal(tickets.length, 1);

  const off = fixture().api;
  const unavailable = await off.adbUpload(up({ args: ["install", "@file0"], files: [file] }), stored.id);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, "direct_upload_unavailable");
});

test("recording grid passes the grid options, keeps the X-Grid headers and accepts file?format=grid", async () => {
  const sent: unknown[] = [];
  const { api } = fixture({ user: async () => ({ id: 7, authKind: "agent" }),
    recording: async (_userId, _id, action, body) => {
      sent.push([action, body]);
      return new Response(new Uint8Array([0xff, 0xd8]), { headers: { "content-type": "image/jpeg", "x-grid-pages": "2", "x-other": "no" } });
    } });
  const path = `/v1/phones/${stored.id}/recording`;
  const grid = await api.recording(get(`${path}/grid?fps=0.5&page=1&evil=1`), stored.id, "grid");
  assert.equal(grid.headers.get("content-type"), "image/jpeg");
  assert.equal(grid.headers.get("x-grid-pages"), "2");
  assert.equal(grid.headers.get("x-other"), null);
  assert.deepEqual(sent[0], ["grid", { fps: "0.5", page: "1" }]);
  assert.equal((await api.recording(get(`${path}/file?format=grid`), stored.id, "file")).status, 200);
  assert.deepEqual(sent[1], ["grid", {}]);
  assert.equal((await api.recording(get(`${path}/grid?fps=abc`), stored.id, "grid")).status, 400);
});

test("screenshot checks scale and says which scale came back", async () => {
  const scales: unknown[] = [];
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const { api } = fixture({ user: async () => ({ id: 7, authKind: "agent" }),
    screenshot: async (_userId, _id, scale) => {
      scales.push(scale);
      return new Response(png, { headers: { "content-type": "image/png", ...(scale ? { "x-screenshot-scale": String(scale) } : {}) } });
    } });
  const path = `/v1/phones/${stored.id}/screenshot`;
  const small = await api.screenshot(get(`${path}?scale=0.5`), stored.id);
  assert.equal(small.headers.get("content-type"), "image/png");
  assert.equal(small.headers.get("x-screenshot-scale"), "0.5");
  const full = await api.screenshot(get(path), stored.id);
  assert.equal(full.headers.get("x-screenshot-scale"), "1");
  assert.deepEqual(scales, [0.5, undefined]);
  assert.equal((await api.screenshot(get(`${path}?scale=3`), stored.id)).status, 400);
});

test("ui passes all=1, keeps the runner's hint, and asks an old runner to update", async () => {
  const calls: boolean[] = [];
  let reply = Response.json({ package: "com.example", count: 1, nodes: [{ text: "OK", tap: [1, 2] }] });
  const { api } = fixture({ user: async () => ({ id: 7, authKind: "agent" }),
    ui: async (_userId, _id, all) => { calls.push(all); return reply; } });
  const path = `/v1/phones/${stored.id}/ui`;
  assert.equal((await (await api.ui(get(`${path}?all=1`), stored.id)).json()).package, "com.example");
  assert.deepEqual(calls, [true]);
  assert.equal((await api.ui(get(`${path}?all=yes`), stored.id)).status, 400);
  reply = Response.json({ error: "uiautomator found no window. Wait 1 s and retry.", errorCode: "ui_unavailable" }, { status: 503 });
  const busy = await api.ui(get(path), stored.id);
  assert.equal(busy.status, 503);
  assert.deepEqual(await busy.json(), { error: "ui_unavailable", message: "uiautomator found no window. Wait 1 s and retry." });
  reply = Response.json({ error: "not found" }, { status: 404 });
  assert.equal((await (await api.ui(get(path), stored.id)).json()).error, "runner_update_required");
});

test("a screenshot that times out says timeout and when to retry", async () => {
  const { api } = fixture({ user: async () => ({ id: 7, authKind: "agent" }),
    screenshot: async () => { throw new RunnerTimeoutError("The phone did not answer /screenshot in time."); } });
  const response = await api.screenshot(get(`/v1/phones/${stored.id}/screenshot?scale=0.5`), stored.id);
  assert.equal(response.status, 504);
  assert.equal(response.headers.get("retry-after"), "5");
  const body = await response.json() as { error: string; retry_after: number; message: string };
  assert.equal(body.error, "timeout");
  assert.equal(body.retry_after, 5);
  assert.match(body.message, /Retry in 5 s\./);
});

test("an adb error says whether the command ran, and the Idempotency-Key reaches the runner", async () => {
  const keys: unknown[] = [];
  let reply: () => Response | Promise<Response> = () => Response.json({ exit_code: 0, stdout: "", stderr: "" });
  const { api } = fixture({ user: async () => ({ id: 7, authKind: "agent" }),
    adb: async (_userId, _id, input) => { keys.push(input.key); return reply(); } });
  const tap = (headers: Record<string, string> = {}) =>
    api.adb(post(`/v1/phones/${stored.id}/adb`, { args: ["shell", "input", "tap", "1", "2"] }, headers), stored.id);

  assert.equal((await tap({ "idempotency-key": "tap-1" })).status, 200);
  assert.deepEqual(keys, ["tap-1"]);
  assert.equal((await tap({ "idempotency-key": "bad key!" })).status, 400);

  reply = () => Response.json({ error: "Another adb command is running.", errorCode: "runner_error", ran: false }, { status: 409 });
  assert.deepEqual(await (await tap()).json(), { error: "phone_conflict", message: "Another adb command is running.", ran: false });

  reply = () => Response.json({ error: "adb timed out after 32 s. The command may have run.", ran: "unknown", replayed: true }, { status: 504 });
  const timeout = await (await tap()).json();
  assert.equal(timeout.error, "adb_timeout");
  assert.equal(timeout.ran, "unknown");
  assert.equal(timeout.replayed, true);

  // A reply that is not JSON (a proxy page) or a dropped connection may come after the tap.
  reply = () => new Response("<html>Bad gateway</html>", { status: 502 });
  const lost = await (await tap()).json();
  assert.equal(lost.ran, "unknown");
  assert.match(lost.message, /may have run/);
  reply = () => { throw new Error("socket hang up"); };
  const dropped = await tap();
  assert.equal(dropped.status, 502);
  assert.equal((await dropped.json()).ran, "unknown");
});

test("the X-Emuly-Note header reaches the adb log and the screenshot row", async () => {
  const logged: unknown[] = [];
  const acted: unknown[] = [];
  const { api } = fixture({
    user: async () => ({ id: 7, authKind: "agent", agentKeyId: 42 }),
    log: call => { logged.push({ args: call.args, note: call.note }); },
    action: call => { acted.push(call); },
    screenshot: async () => new Response(new Uint8Array([0x89]), { headers: { "content-type": "image/png" } }),
  });
  await api.adb(post(`/v1/phones/${stored.id}/adb`, { args: ["shell", "input", "tap", "1", "2"] },
    { "x-emuly-note": "Open%20Wi-Fi%20settings\n" }), stored.id);
  assert.deepEqual(logged, [{ args: ["shell", "input", "tap", "1", "2"], note: "Open Wi-Fi settings" }]);
  await api.adb(post(`/v1/phones/${stored.id}/adb`, { args: ["shell", "id"] }), stored.id);
  assert.equal((logged[1] as { note: unknown }).note, null);

  await api.screenshot(new Request(`https://emuly.test/v1/phones/${stored.id}/screenshot?scale=0.5`,
    { headers: { "x-emuly-note": "Check the toast" } }), stored.id);
  assert.deepEqual(acted, [{ userId: 7, phoneId: stored.id, agentKeyId: 42, label: "Took a screenshot",
    command: "GET screenshot?scale=0.5", note: "Check the toast" }]);
});

test("a screenshot from the browser session writes no agent row", async () => {
  const acted: unknown[] = [];
  const { api } = fixture({ action: call => { acted.push(call); },
    screenshot: async () => new Response(new Uint8Array([0x89]), { headers: { "content-type": "image/png" } }) });
  await api.screenshot(get(`/v1/phones/${stored.id}/screenshot`), stored.id);
  assert.deepEqual(acted, []);
});

test("a GitHub refusal names the GitHub account, so the agent can point at its billing", async () => {
  const { api } = fixture({
    user: async () => ({ id: 7, login: "octo-cat", authKind: "agent", agentKeyId: 3 }),
    service: {
      start: async () => { throw new GitHubError("There is a billing issue that is preventing you from starting this codespace.", 403); },
      stop: async () => { throw new GitHubError("refused", 409); },
    },
  });
  const response = await api.start(post(`/v1/phones/${stored.id}/start`), stored.id);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "github_refused",
    message: "There is a billing issue that is preventing you from starting this codespace.", github_login: "octo-cat" });
  const anonymous = fixture({ service: { start: async () => { throw new GitHubError("refused", 403); }, stop: async (_userId, id) => id } });
  const without = await anonymous.api.start(post(`/v1/phones/${stored.id}/start`, undefined, { origin: "https://emuly.test" }), stored.id);
  assert.equal("github_login" in await without.json(), false);
});

test("agent commands give the runner helpers the codespace of the phone row they already read", async () => {
  const known = { ...stored, codespace_name: "cs-quiet-falcon" };
  const seen: Record<string, string | undefined> = {};
  const png = () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } });
  let reads = 0;
  const { api } = fixture({
    user: async () => ({ id: 7, authKind: "agent", agentKeyId: 42 }),
    phone: async () => { reads += 1; return known; },
    adb: async (_u, _i, _input, codespaceName) => { seen.adb = codespaceName; return Response.json({ exit_code: 0, stdout: "", stderr: "" }); },
    agentDevice: async (_u, _i, codespaceName) => { seen.agentDevice = codespaceName; return { ready: true, token: "proxy-token", version: "1" }; },
    screenshot: async (_u, _i, _scale, codespaceName) => { seen.screenshot = codespaceName; return png(); },
    ui: async (_u, _i, _all, codespaceName) => { seen.ui = codespaceName; return Response.json({ nodes: [] }); },
    recording: async (_u, _i, _action, _body, codespaceName) => { seen.recording = codespaceName; return Response.json({ recording: false }); },
  });
  const base = `/v1/phones/${stored.id}`;
  assert.equal((await api.adb(post(`${base}/adb`, { args: ["shell", "id"] }), stored.id)).status, 200);
  assert.equal((await api.agentDevice(get(`${base}/agent-device`), stored.id)).status, 200);
  assert.equal((await api.screenshot(get(`${base}/screenshot`), stored.id)).status, 200);
  assert.equal((await api.ui(get(`${base}/ui`), stored.id)).status, 200);
  assert.equal((await api.recording(get(`${base}/recording/status`), stored.id, "status")).status, 200);
  assert.deepEqual(seen, { adb: "cs-quiet-falcon", agentDevice: "cs-quiet-falcon", screenshot: "cs-quiet-falcon",
    ui: "cs-quiet-falcon", recording: "cs-quiet-falcon" }, "each helper gets the row, so it does not read it again");
  assert.equal(reads, 5, "one phone read for each command");
});

test("each runner helper skips its own phone read when it gets the codespace", () => {
  const source = readFileSync("lib/phone/phone-runner.ts", "utf8");
  assert.match(source, /export async function runnerRequest\([^)]*known\?: string\) \{\s+if \(known\) return links\(\)\.request/);
  assert.match(source, /export async function runnerAdb\([^)]*known\?: string\) \{\s+const codespaceName = known \?\? await readyCodespace/);
  assert.match(source, /export async function runnerRecording\([^)]*known\?: string\) \{\s+if \(known\) return links\(\)\.recording/);
  assert.match(source, /export async function runnerAgentDevice\([^)]*known\?: string\) \{\s+const codespaceName = known \?\? await readyCodespace/);
  const wiring = readFileSync("lib/api.ts", "utf8");
  assert.match(wiring, /screenshot: \(userId, id, scale, codespaceName\) => runnerRequest\([^\n]*, codespaceName\)/);
  assert.match(wiring, /ui: \(userId, id, all, codespaceName\) => runnerRequest\([^\n]*, codespaceName\)/);
});
