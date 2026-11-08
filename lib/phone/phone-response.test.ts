import { test } from "node:test";
import assert from "node:assert/strict";
import { APK_MAX_BYTES, installFinished } from "./phone-apps-contract.ts";
import { PhoneResponseError, parseAppInventory, parseAppInstall, parseAppInstalls, parseAppOpened,
  parsePhoneError, parseRunnerUpdate, parseStreamTicket, readPhoneResponse } from "./phone-response.ts";

const operation = { id: "11111111-1111-4111-8111-111111111111", source: "upload", filename: "app.apk",
  stage: "uploading", bytesReceived: 0, totalBytes: 10, canCancel: true };

test("inventory validates every app and retains compatible response metadata", () => {
  const value = { apps: [{ packageId: "com.example.app", versionCode: "123", launchable: true },
    { packageId: "com.example.other", versionCode: null, launchable: false }], fetchedAt: "2026-11-08T10:00:00.000Z" };
  assert.deepEqual(parseAppInventory(value), value);
  assert.deepEqual(parseAppInventory({ apps: [] }), { apps: [] });
  for (const invalid of [null, [], {}, { apps: {} }, { apps: [null] }, { apps: [value.apps[0], {}] },
    { apps: [{ ...value.apps[0], packageId: "bad package" }] }, { apps: [{ ...value.apps[0], versionCode: 123 }] },
    { apps: [{ ...value.apps[0], launchable: "false" }] }, { apps: [], fetchedAt: "invalid" }]) {
    assert.throws(() => parseAppInventory(invalid), PhoneResponseError);
  }
});

test("installation contracts accept all current stages, unknown download sizes, and extension fields", () => {
  for (const [stage, finished] of [
    ["uploading", false], ["downloading", false], ["validating", false], ["installing", false],
    ["succeeded", true], ["failed", true], ["cancelled", true], ["expired", true], ["interrupted", true],
  ] as const) {
    assert.equal(installFinished(stage), finished);
    const value = { ...operation, stage, source: "url", totalBytes: null, bytesReceived: APK_MAX_BYTES,
      packageId: "com.example.app", versionCode: "42", errorCode: "install_failed", message: "Try another APK.", createdAt: "2026-11-08" };
    assert.deepEqual(parseAppInstall(value), value);
    assert.deepEqual(parseAppInstalls({ operations: [value] }), { operations: [value] });
  }
  assert.deepEqual(parseAppInstalls({ operations: [] }), { operations: [] });
});

test("installation contracts reject unsafe progress, unknown stages, and malformed optional fields", () => {
  const changes = [ { id: "not-an-id" }, { source: "other" }, { filename: null }, { stage: "new-stage" }, { stage: "toString" }, { stage: "__proto__" },
    { bytesReceived: -1 }, { bytesReceived: 1.5 }, { bytesReceived: NaN }, { bytesReceived: Infinity },
    { bytesReceived: APK_MAX_BYTES + 1 }, { bytesReceived: 11 }, { totalBytes: 0 }, { totalBytes: "10" },
    { totalBytes: APK_MAX_BYTES + 1 }, { canCancel: 1 }, { packageId: {} }, { versionCode: false },
    { errorCode: [] }, { message: { internal: "details" } } ];
  for (const change of changes) assert.throws(() => parseAppInstall({ ...operation, ...change }), PhoneResponseError);
  for (const invalid of [null, [], {}, { operations: null }, { operations: [operation, {}] }]) {
    assert.throws(() => parseAppInstalls(invalid), PhoneResponseError);
  }
});

test("errors and action responses validate their fields without rejecting new error codes", () => {
  assert.deepEqual(parsePhoneError({ error: "Runner needs an update.", errorCode: "runner_update_required" }),
    { error: "Runner needs an update.", errorCode: "runner_update_required" });
  assert.deepEqual(parsePhoneError({ error: "Future failure", errorCode: "future_error" }), { error: "Future failure", errorCode: "future_error" });
  assert.deepEqual(parsePhoneError({ error: "Failure" }), { error: "Failure" });
  assert.deepEqual(parseAppOpened({ ok: true }), { ok: true });
  for (const status of ["ready", "working"]) assert.deepEqual(parseRunnerUpdate({ status }), { status });
  for (const value of [null, {}, { error: {} }, { error: "" }, { error: "Failed", errorCode: 3 }]) {
    assert.throws(() => parsePhoneError(value), PhoneResponseError);
  }
  assert.throws(() => parseAppOpened({ ok: "true" }), PhoneResponseError);
  assert.throws(() => parseRunnerUpdate({ status: "unknown" }), PhoneResponseError);
});

test("stream tickets require a bounded token and allow absent diagnostics", () => {
  for (const value of [{ ticket: "synthetic-token" }, { ticket: "synthetic-token", attemptId: "attempt" }]) {
    assert.deepEqual(parseStreamTicket(value), value);
  }
  for (const value of [null, [], {}, { ticket: "" }, { ticket: {} }, { ticket: "a".repeat(257) },
    { ticket: "contains spaces" }, { ticket: "token", attemptId: 1 }, { ticket: "token", attemptId: "" }]) {
    assert.throws(() => parseStreamTicket(value), PhoneResponseError);
  }
});

test("invalid JSON produces the same safe contract error as incompatible JSON", async () => {
  for (const body of ["not json", "null", '{"apps":false}']) {
    await assert.rejects(readPhoneResponse(new Response(body), parseAppInventory),
      { message: "Invalid phone response. Refresh status before retrying." });
  }
  assert.deepEqual(await readPhoneResponse(Response.json({ apps: [] }), parseAppInventory), { apps: [] });
});
