import test from "node:test";
import assert from "node:assert/strict";
import { crossOrigin } from "./origin.ts";

const req = (headers: Record<string, string>) => new Request("https://emuly.dev/v1/phones", { method: "POST", headers });

test("a cookie request with no Origin is refused; an agent key request is allowed", () => {
  assert.equal(crossOrigin(req({}), "session"), true);
  assert.equal(crossOrigin(req({}), undefined), true);
  assert.equal(crossOrigin(req({}), "agent"), false);
});

test("same origin passes and another origin fails for every caller", () => {
  assert.equal(crossOrigin(req({ origin: "https://emuly.dev" }), "session"), false);
  assert.equal(crossOrigin(req({ origin: "https://evil.example" }), "agent"), true);
  assert.equal(crossOrigin(req({ origin: "https://emuly.dev", "sec-fetch-site": "cross-site" }), "agent"), true);
});

test("requireOrigin refuses a missing Origin even for an agent key", () => {
  assert.equal(crossOrigin(req({}), "agent", { requireOrigin: true }), true);
  assert.equal(crossOrigin(req({ origin: "https://emuly.dev" }), "agent", { requireOrigin: true }), false);
});
