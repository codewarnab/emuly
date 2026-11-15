import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createUpdateCheck, newer } from "./update-check.ts";

const remote = (version: string) => async () => `export const AGENT_RUNBOOK_VERSION = "${version}";`;
const file = () => join(mkdtempSync(join(tmpdir(), "emuly-update-")), "update-dismissed");

test("newer compares the date, then the number", () => {
  assert.ok(newer("2026-11-15.10", "2026-11-15.2"));
  assert.ok(newer("2026-11-16.1", "2026-11-15.9"));
  assert.ok(!newer("2026-11-15.2", "2026-11-15.2"));
});

test("hints only when GitHub has a newer version", async () => {
  const same = createUpdateCheck({ current: "2026-11-15.2", enabled: true, dismissFile: file(), fetchText: remote("2026-11-15.2") });
  assert.equal(await same.hint("http://localhost:4321"), null);
  const behind = createUpdateCheck({ current: "2026-11-15.2", enabled: true, dismissFile: file(), fetchText: remote("2026-11-20.1") });
  assert.deepEqual(await behind.hint("http://localhost:4321/"), {
    current: "2026-11-15.2", latest: "2026-11-20.1",
    notes: "https://github.com/codewarnab/emuly/commits/main", dismiss: "http://localhost:4321/v1/update/dismiss",
  });
});

test("a no stays quiet until a still newer version ships", async () => {
  const dismissFile = file();
  let version = "2026-11-20.1";
  let now = 0;
  const check = createUpdateCheck({ current: "2026-11-15.2", enabled: true, dismissFile,
    fetchText: async () => remote(version)(), clock: () => now });
  assert.equal(await check.dismiss(), "2026-11-20.1");
  assert.equal(await check.hint("http://x"), null);
  version = "2026-11-25.1"; now += 25 * 60 * 60_000;
  assert.equal((await check.hint("http://x"))?.latest, "2026-11-25.1");
});

test("off, offline, or garbage never hints", async () => {
  const off = createUpdateCheck({ current: "2026-11-15.2", enabled: false, dismissFile: file(), fetchText: remote("2027-01-01.1") });
  assert.equal(await off.hint("http://x"), null);
  const offline = createUpdateCheck({ current: "2026-11-15.2", enabled: true, dismissFile: file(), fetchText: () => Promise.reject(new Error("offline")) });
  assert.equal(await offline.hint("http://x"), null);
  const garbage = createUpdateCheck({ current: "2026-11-15.2", enabled: true, dismissFile: file(), fetchText: async () => "nope" });
  assert.equal(await garbage.hint("http://x"), null);
});
