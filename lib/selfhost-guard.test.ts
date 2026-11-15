import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSelfHostEnvironment } from "../selfhost-guard.mjs";

test("self-host rejects hosted deployments and allows loopback builds", () => {
  assert.throws(() => assertSelfHostEnvironment({ EMULY_SELF_HOST: "1", VERCEL: "1" }), /cannot be used/);
  assert.throws(() => assertSelfHostEnvironment({ EMULY_SELF_HOST: "1", NODE_ENV: "production", EMULY_BASE_URL: "https://example.com" }), /cannot be used/);
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.doesNotThrow(() => assertSelfHostEnvironment({ EMULY_SELF_HOST: "1", NODE_ENV: "production", EMULY_BASE_URL: `https://${host}:4321` }));
  }
  assert.doesNotThrow(() => assertSelfHostEnvironment({ VERCEL: "1" }));
  assert.doesNotThrow(() => assertSelfHostEnvironment({ EMULY_SELF_HOST: "1" }));
});
