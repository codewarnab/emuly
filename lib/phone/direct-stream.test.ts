import { test } from "node:test";
import assert from "node:assert/strict";
import { directStream, directStreamEnabled, ensureDirectPort } from "./direct-stream.ts";
import { parseStreamTicket } from "./phone-response.ts";

const input = { userId: 7, phoneId: "ph", codespaceName: "phone-a", sessionId: "s", quality: "auto", origin: "https://emuly.xyz" };
function env(t: { after: (fn: () => void) => void }, values: Record<string, string | undefined>) {
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : process.env[key] = value;
  t.after(() => { for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value; });
}

test("the flag is off by default, and needs the secret", t => {
  env(t, { EMULY_DIRECT_SECRET: "s".repeat(40), EMULY_DIRECT_STREAM: undefined });
  assert.equal(directStreamEnabled(7), false);
  assert.equal(directStreamEnabled(7, "all"), true);
  assert.equal(directStreamEnabled(7, "3, 7"), true);
  assert.equal(directStreamEnabled(8, "3,7"), false);
  env(t, { EMULY_DIRECT_SECRET: undefined });
  assert.equal(directStreamEnabled(7, "all"), false);
});

test("a public port gives a direct URL and a ticket that the browser parser accepts", async t => {
  env(t, { EMULY_DIRECT_SECRET: "s".repeat(40), EMULY_DIRECT_STREAM: "all" });
  const direct = await directStream(input, { ensure: async () => true });
  assert.equal(direct?.url, "wss://phone-a-8791.app.github.dev");
  assert.deepEqual(parseStreamTicket({ ticket: "abc", direct }).direct, direct);
});

test("no public port, or a slow one, gives no direct ticket", async t => {
  env(t, { EMULY_DIRECT_SECRET: "s".repeat(40), EMULY_DIRECT_STREAM: "all" });
  assert.equal(await directStream(input, { ensure: async () => false }), undefined);
  assert.equal(await directStream(input, { ensure: () => new Promise(r => setTimeout(() => r(true), 100)), waitMs: 10 }), undefined);
});

test("the port call runs once per codespace, and a failure is tried again", async () => {
  let calls = 0;
  const publish = async () => { calls++; return calls > 1; };
  const token = async () => "token";
  assert.equal(await ensureDirectPort(1, "cs-x", publish, token), false);
  await new Promise(r => setImmediate(r));
  assert.equal(await ensureDirectPort(1, "cs-x", publish, token), true);
  assert.equal(await ensureDirectPort(1, "cs-x", publish, token), true);
  assert.equal(calls, 2);
});

test("the browser parser drops a direct part that points elsewhere", () => {
  for (const url of ["wss://evil.example", "ws://phone-a-8791.app.github.dev", "wss://phone-a-8790.app.github.dev", "wss://x.app.github.dev.evil.com"]) {
    assert.equal(parseStreamTicket({ ticket: "abc", direct: { url, ticket: "a.b" } }).direct, undefined, url);
  }
  assert.equal(parseStreamTicket({ ticket: "abc", direct: { url: "wss://phone-a-8791.app.github.dev", ticket: "a.b.c" } }).direct, undefined);
});
