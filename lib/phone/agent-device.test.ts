import { test } from "node:test";
import assert from "node:assert/strict";
import { agentDeviceBaseUrl, agentDeviceInfo, agentDevicePath, agentDeviceSession, agentDeviceUnavailable,
  bearerToken, proxyRequestHeaders } from "./agent-device.ts";

test("the public base URL is the app's proxy route, not the codespace", () => {
  assert.equal(agentDeviceBaseUrl("https://emuly.test/", "phone-quiet-falcon"),
    "https://emuly.test/v1/phones/phone-quiet-falcon/agent-device-proxy/agent-device");
  assert.equal(agentDeviceBaseUrl("https://emuly.test", "phone a/b"),
    "https://emuly.test/v1/phones/phone%20a%2Fb/agent-device-proxy/agent-device");
  assert.equal(agentDeviceSession("phone-quiet-falcon"), "emuly-phone-quiet-falcon");
});

test("runner info becomes a proxy token only when it says ready", () => {
  assert.deepEqual(agentDeviceInfo({ ready: true, token: "secret-token", version: "0.21.36" }),
    { token: "secret-token", version: "0.21.36" });
  assert.deepEqual(agentDeviceInfo({ ready: true, token: "secret-token", version: null }),
    { token: "secret-token", version: null });
  assert.equal(agentDeviceInfo({ ready: false, token: "secret-token" }), null);
  assert.equal(agentDeviceInfo({ ready: true, token: "" }), null);
  assert.equal(agentDeviceInfo({ ready: true }), null);
  assert.equal(agentDeviceInfo({ ready: "true", token: "secret-token" }), null);
  assert.equal(agentDeviceInfo(null), null);
});

test("unavailable is one 404 with no reason attached", async () => {
  const response = agentDeviceUnavailable();
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "agent-device is not available on this phone" });
});

test("catch-all segments are encoded and unsafe segments never reach the runner", () => {
  assert.equal(agentDevicePath(["health"]), "/agent-device/health");
  assert.equal(agentDevicePath(["devices", "emulator-5554", "screenshot"]), "/agent-device/devices/emulator-5554/screenshot");
  assert.equal(agentDevicePath(["a b", "c?d"]), "/agent-device/a%20b/c%3Fd");
  assert.equal(agentDevicePath(["health"], "?verbose=1&x=a%20b"), "/agent-device/health?verbose=1&x=a%20b");
  for (const segments of [[], [".."], ["."], ["a", ".."], [""], ["a/b"], ["a\\b"], ["a\u0000b"], ["x".repeat(513)],
    Array.from({ length: 65 }, () => "a")]) {
    assert.equal(agentDevicePath(segments), null, JSON.stringify(segments).slice(0, 80));
  }
  assert.equal(agentDevicePath(["health"], "#fragment"), null);
  assert.equal(agentDevicePath(["health"], "?x=\u0000"), null);
  assert.equal(agentDevicePath(["health"], "verbose=1"), null, "a bare query is not a search string");
});

test("only a bearer authorization counts as the proxy credential", () => {
  assert.equal(bearerToken("Bearer abc123"), "abc123");
  assert.equal(bearerToken("bearer abc123"), "abc123");
  assert.equal(bearerToken("  Bearer abc123  "), "abc123");
  assert.equal(bearerToken(null), null);
  assert.equal(bearerToken("abc123"), null);
  assert.equal(bearerToken("Basic abc123"), null);
  assert.equal(bearerToken("Bearer "), null);
});

test("relayed headers keep the message but drop session, runner and hop-by-hop credentials", () => {
  const headers = proxyRequestHeaders(new Headers({
    host: "emuly.test", cookie: "session=secret", "x-phone-secret": "runner-secret", "x-github-token": "github-secret",
    connection: "keep-alive", "transfer-encoding": "chunked", "x-forwarded-for": "1.2.3.4", forwarded: "for=1.2.3.4",
    authorization: "Bearer proxy-token", "content-type": "application/json", accept: "application/json",
    "x-request-id": "abc",
  }));
  assert.deepEqual(Object.fromEntries(headers), {
    authorization: "Bearer proxy-token", "content-type": "application/json", accept: "application/json", "x-request-id": "abc",
  });
});
