import { test } from "node:test";
import assert from "node:assert/strict";
import { addAgentHelp, callerOf, phoneNotReady, withAgentHelp } from "./agent-help.ts";
import { V1_ROUTES } from "./v1-routes.ts";

const BASE = "https://emuly.example";
const ctx = (status: number, pathname: string, headers: Record<string, string> = {}, retryAfter?: string) =>
  ({ status, pathname, headers: new Headers(headers), baseUrl: BASE, retryAfter });
const curl = { "user-agent": "curl/8.5.0", authorization: "Bearer k" };

/** Every fix path must be a real /v1 route, so an agent never follows a fix into a 404. */
function assertRoute(fix: { method: string; path: string; then?: unknown } | undefined) {
  if (!fix) return;
  const path = fix.path.split("?")[0]!;
  const known = V1_ROUTES.some(route => {
    const [method, template] = route.split(" ") as [string, string];
    const pattern = new RegExp(`^${template.split("/").map(part => part.startsWith("{")
      ? (part.includes("|") ? `(?:${part.slice(1, -1)})` : "[^/]+") : part).join("/")}/?$`);
    return method === fix.method && pattern.test(path);
  });
  assert.ok(known, `${fix.method} ${path} is not a /v1 route`);
  assertRoute(fix.then as typeof fix | undefined);
}

test("callerOf tells the CLI, PowerShell, curl, the skill and the browser apart", () => {
  assert.equal(callerOf(new Headers({ "x-emuly-client": "cli/abc1234" })), "cli");
  assert.equal(callerOf(new Headers({ "user-agent": "Mozilla/5.0 (Windows NT 10.0; Microsoft Windows 10.0.22631; en-US) WindowsPowerShell/5.1.22621", authorization: "Bearer k" })), "powershell");
  assert.equal(callerOf(new Headers({ "user-agent": "Mozilla/5.0 (Windows NT; Windows NT 10.0; en-US) PowerShell/7.4.1" })), "powershell");
  assert.equal(callerOf(new Headers(curl)), "curl");
  assert.equal(callerOf(new Headers({ ...curl, "x-emuly-skill": "0123456789ab" })), "skill");
  assert.equal(callerOf(new Headers({ "user-agent": "Mozilla/5.0 (X11; Linux) Chrome/130" })), "browser");
  assert.equal(callerOf(new Headers({ "user-agent": "python-requests/2.32", authorization: "Bearer k" })), "other");
});

test("phone_not_ready says wait, not start, while the phone boots", () => {
  const booting = phoneNotReady("p-1", { state: "running", android_state: "booting" });
  assert.equal(booting.body.fix && (booting.body.fix as { method: string }).method, "GET");
  assert.match(String((booting.body.fix as { path: string }).path), /wait_for=ready/);
  assert.equal(booting.headers?.["Retry-After"], "10");
  assert.match(String(booting.body.message), /Do not start it again/);
  for (const state of [["stopped", "stopped"], ["running", "booting"], ["stopping", "ready"], ["deleted", "stopped"], ["error", "stopped"], ["starting", "stopped"]]) {
    const { body } = phoneNotReady("p-1", { state: state[0]!, android_state: state[1]! });
    assert.equal(body.error, "phone_not_ready");
    assertRoute(body.fix as never);
  }
  const stopped = phoneNotReady("p-1", { state: "stopped", android_state: "stopped" }).body.fix as { method: string; path: string };
  assert.deepEqual([stopped.method, stopped.path], ["POST", "/v1/phones/p-1/start"]);
});

test("unauthorized gets a reason and the device sign-in, the same for any bad key", () => {
  const missing = addAgentHelp({ error: "unauthorized" }, ctx(401, "/v1/phones", { "user-agent": "curl/8" }));
  assert.equal(missing.reason, "missing_credentials");
  const bad = addAgentHelp({ error: "unauthorized" }, ctx(401, "/v1/phones", curl));
  assert.equal(bad.reason, "invalid_credentials");
  assert.equal(bad.needs_user, true);
  assertRoute(bad.fix as never);
});

test("use_cli goes to every caller but the CLI and the browser, with the right shell", () => {
  const help = addAgentHelp({ error: "unauthorized" }, ctx(401, "/v1/phones", curl));
  assert.deepEqual((help.use_cli as { install: string }).install, `curl -fsSL ${BASE}/v1/cli -o emuly.mjs`);
  const ps = addAgentHelp({ error: "busy" }, ctx(409, "/v1/phones/p-1/adb", { "user-agent": "Mozilla/5.0 WindowsPowerShell/5.1" }));
  assert.match((ps.use_cli as { install: string }).install, /^Invoke-WebRequest /);
  assert.equal((ps.use_cli as { then: string }).then, "node emuly.mjs install p-1 app.apk");
  assert.equal(addAgentHelp({ error: "busy" }, ctx(409, "/v1/phones/p-1/adb", { "x-emuly-client": "cli/abc1234" })).use_cli, undefined);
  assert.equal(addAgentHelp({ error: "busy" }, ctx(409, "/v1/phones/p-1/adb", { "user-agent": "Mozilla/5.0 Chrome" })).use_cli, undefined);
});

test("known codes get a fix that is a real route; a route's own fields are kept", () => {
  const notFound = addAgentHelp({ error: "not_found", message: "Phone not found." }, ctx(404, "/v1/phones/p-9/adb", curl));
  assertRoute(notFound.fix as never);
  const runner = addAgentHelp({ error: "runner_update_required", message: "m" }, ctx(503, "/v1/phones/p-1/ui", curl));
  assertRoute(runner.fix as never);
  assertRoute(runner.if_fix_fails as never);
  assert.deepEqual((runner.fix as { repeat_until: unknown }).repeat_until, { status: "ready" });
  const own = addAgentHelp({ error: "busy", max_retries: 9 }, ctx(409, "/v1/phones/p-1/adb", curl, "5"));
  assert.equal(own.max_retries, 9);
  assert.equal(own.retry_after, 5);
  const failed = addAgentHelp({ error: "request_failed", message: "x" }, ctx(502, "/v1/phones", curl));
  assert.equal(failed.retry_after, 3);
  assert.equal(failed.max_retries, 1);
  // Not our error shape: unchanged.
  assert.deepEqual(addAgentHelp({ message: "x" }, ctx(500, "/v1/phones", curl)), { message: "x" });
});

test("withAgentHelp keeps status and headers and skips non-errors and non-JSON", async () => {
  const request = new Request(`${BASE}/v1/phones/p-1/adb`, { headers: curl });
  const ok = Response.json({ a: 1 });
  assert.equal(await withAgentHelp(ok, request, BASE), ok);
  const png = new Response("x", { status: 500, headers: { "content-type": "image/png" } });
  assert.equal(await withAgentHelp(png, request, BASE), png);
  const busy = Response.json({ error: "busy", message: "m" }, { status: 409, headers: { "Retry-After": "5", "Cache-Control": "private, no-store" } });
  const helped = await withAgentHelp(busy, request, BASE);
  assert.equal(helped.status, 409);
  assert.equal(helped.headers.get("retry-after"), "5");
  assert.equal(helped.headers.get("cache-control"), "private, no-store");
  const body = await helped.json() as Record<string, unknown>;
  assert.equal(body.retry_after, 5);
  assert.ok(body.use_cli);
});

test("a lost adb reply (ran unknown) never gets a plain retry", () => {
  for (const code of ["adb_timeout", "adb_failed", "request_failed", "timeout"]) {
    const bare = addAgentHelp({ error: code, message: "x", ran: "unknown" }, ctx(504, "/v1/phones/p-1/adb", curl));
    assertRoute(bare.fix as never);
    assert.deepEqual(bare.fix, { method: "GET", path: "/v1/phones/p-1/screenshot" }, code);
    assert.deepEqual(bare.if_fix_fails, { send_again: true, new_idempotency_key: true });
    assert.equal(bare.max_retries, 1);
    const keyed = addAgentHelp({ error: code, message: "x", ran: "unknown" }, ctx(504, "/v1/phones/p-1/adb", { ...curl, "idempotency-key": "tap-1" }));
    assert.deepEqual(keyed.fix, { same_request: true, same_idempotency_key: true }, code);
    assert.equal(keyed.max_retries, 2);
    assert.ok(!JSON.stringify(keyed).includes("tap-1"), "the key is never echoed");
  }
  const notRun = addAgentHelp({ error: "request_failed", message: "x", ran: false }, ctx(502, "/v1/phones/p-1/adb", curl));
  assert.equal(notRun.retry_after, 3);
  assert.equal(notRun.max_retries, 1);
});
