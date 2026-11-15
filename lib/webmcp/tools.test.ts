import { test } from "node:test";
import assert from "node:assert/strict";
import { createTools, type ToolDeps } from "./tools.ts";

type Route = (init: RequestInit) => { status: number; body: unknown };

function setup(routes: Record<string, Route | Route[]>, page = { path: "/app", search: "" }) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const navigated: string[] = [];
  let clock = 0;
  const deps: ToolDeps = {
    fetch: (async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const entry = routes[`${method} ${path}`];
      const route = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]) : entry;
      const { status, body } = route ? route(init) : { status: 404, body: {} };
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch,
    path: () => page.path,
    search: () => new URLSearchParams(page.search),
    navigate: url => { navigated.push(url); },
    waitForDeviceResult: async () => "approved",
    deviceState: () => null,
    choosePlan: () => true,
    sleep: async ms => { clock += ms; },
    now: () => clock,
  };
  const tools = Object.fromEntries(createTools(deps).map(tool => [tool.name, tool]));
  const run = async (name: string, input: Record<string, unknown> = {}) =>
    { const raw = (await tools[name].execute(input)).content[0].text; try { return JSON.parse(raw); } catch { return raw; } };
  return { run, calls, navigated, deps };
}

const ok = (body: unknown, status = 200): Route => () => ({ status, body });
const phone = (state: string, android: string) => ({ id: "p1", name: "pixel", state, android_state: android, browser_url: "u" });

test("connect_agent opens GitHub sign-in and returns to the link page", async () => {
  const { run, navigated } = setup({ "GET /v1/usage": ok({ error: "unauthorized" }, 401) });
  const result = await run("connect_agent", { code: "abcd2345" });
  assert.equal(result.status, "sign_in_required");
  assert.deepEqual(navigated, [`/auth/start?next=${encodeURIComponent("/link?code=ABCD-2345")}`]);
});

test("connect_agent opens the link page, then waits for the human click", async () => {
  const signedIn = { "GET /v1/usage": ok({}) };
  const first = setup(signedIn);
  assert.equal((await first.run("connect_agent", { code: "ABCD-2345" })).status, "opening");
  assert.deepEqual(first.navigated, ["/link?code=ABCD-2345"]);
  const second = setup(signedIn, { path: "/link", search: "?code=ABCD-2345" });
  assert.equal((await second.run("connect_agent")).status, "approved");
});

test("connect_agent never approves: with no click it asks the user", async () => {
  const { run, deps, calls } = setup({ "GET /v1/usage": ok({}) }, { path: "/link", search: "?code=ABCD-2345" });
  deps.waitForDeviceResult = async () => null;
  assert.equal((await run("connect_agent")).status, "waiting");
  assert.ok(calls.every(call => call.method === "GET"));
});

test("connect_agent asks for the plan on the welcome page", async () => {
  const { run, deps } = setup({ "GET /v1/usage": ok({}) }, { path: "/app/welcome", search: "" });
  assert.equal((await run("connect_agent", { code: "ABCD-2345" })).status, "plan_required");
  let chosen = "";
  deps.choosePlan = plan => { chosen = plan; return true; };
  assert.equal((await run("connect_agent", { code: "ABCD-2345", plan: "pro" })).status, "plan_saved");
  assert.equal(chosen, "pro");
});

test("create_phone creates the phone and waits until Android is ready", async () => {
  const { run, calls } = setup({
    "POST /v1/phones": ok({ id: "p1" }, 201),
    "GET /v1/phones/p1": [ok(phone("booting", "booting")), ok(phone("running", "booting")), ok(phone("running", "ready"))],
  });
  const result = await run("create_phone", { idle_timeout_min: 30 });
  assert.equal(result.status, "ready");
  assert.deepEqual(calls[0].body, { idle_timeout_min: 30 });
  assert.equal(calls.length, 4);
});

test("create_phone stops waiting after 10 minutes", async () => {
  const { run } = setup({ "POST /v1/phones": ok({ id: "p1" }, 201), "GET /v1/phones/p1": ok(phone("booting", "booting")) });
  assert.equal((await run("create_phone")).status, "not_ready");
});

test("manage_phone finds the only phone and starts it", async () => {
  const { run, calls } = setup({
    "GET /v1/phones": ok({ phones: [phone("stopped", "off")] }),
    "POST /v1/phones/p1/start": ok({ status: "starting" }, 202),
    "GET /v1/phones/p1": ok(phone("running", "ready")),
  });
  assert.equal((await run("manage_phone", { action: "start" })).status, "ready");
  assert.ok(calls.some(call => call.path === "/v1/phones/p1/start" && call.method === "POST"));
});

test("manage_phone asks which phone when there are several", async () => {
  const { run } = setup({ "GET /v1/phones": ok({ phones: [phone("stopped", "off"), { ...phone("stopped", "off"), id: "p2", name: "tab" }] }) });
  assert.match(await run("manage_phone", { action: "stop" }), /pixel, tab/);
});

test("get_status gets phones and usage in one call", async () => {
  const { run } = setup({ "GET /v1/phones": ok({ phones: [phone("running", "ready")] }), "GET /v1/usage": ok({ left: 10 }) });
  assert.deepEqual(await run("get_status"), { phones: [phone("running", "ready")], usage: { left: 10 } });
});

test("update_settings saves allowed fields once and drops agent_delete_phones", async () => {
  const { run, calls } = setup({ "PATCH /v1/settings": ok({ auto_keep: true }) });
  await run("update_settings", { auto_keep: true, default_idle_min: 20, agent_delete_phones: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { auto_keep: true, default_idle_min: 20 });
});
