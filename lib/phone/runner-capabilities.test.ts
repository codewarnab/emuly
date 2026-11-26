import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRunnerCapabilities, CAPABILITIES_TTL_MS } from "./runner-capabilities.ts";

const FULL = ["apkUpload", "fileFetch", "urlInstall"];

test("Apps calls ask the runner for /health once, not once per upload chunk", async () => {
  let clock = 0, calls = 0;
  let answer = () => Response.json({ ok: true, capabilities: FULL });
  const capabilities = createRunnerCapabilities(async () => { calls += 1; return answer(); }, () => clock);

  for (let chunk = 0; chunk < 3; chunk++) assert.deepEqual(await capabilities.get(7, "p1"), FULL);
  assert.equal(calls, 1, "three chunks, one /health");

  await capabilities.get(7, "p2");
  assert.equal(calls, 2, "each phone has its own entry");

  clock = CAPABILITIES_TTL_MS + 1;
  await capabilities.get(7, "p1");
  assert.equal(calls, 3, "after 5 minutes /health is asked again");

  capabilities.forget(7, "p1");
  await capabilities.get(7, "p1");
  assert.equal(calls, 4, "a runner upgrade clears the entry");

  answer = () => Response.json({ ok: true, capabilities: ["apkUpload"] });
  capabilities.forget(7, "p1");
  await capabilities.get(7, "p1");
  await capabilities.get(7, "p1");
  assert.equal(calls, 6, "an old runner is not kept, so its update works at once");

  answer = () => new Response("down", { status: 502 });
  capabilities.forget(7, "p1");
  assert.deepEqual(await capabilities.get(7, "p1"), [], "a failed /health gives no capabilities");
  answer = () => Response.json({ ok: true, capabilities: FULL });
  assert.deepEqual(await capabilities.get(7, "p1"), FULL, "a failed /health is not kept");
});

test("the Apps route uses the capability cache, not a /health call per request", () => {
  const source = readFileSync("app/v1/phones/[id]/[...apps]/route.ts", "utf8");
  assert.doesNotMatch(source, /const health = await runnerRequest/);
  assert.match(source, /capabilities\.get\(userId, id\)/);
  assert.match(source, /capabilities\.forget\(userId, id\)/);
});
