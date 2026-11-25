import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunnerKey } from "../../phone/runner/runner-key.mjs";

const A = "a".repeat(64), B = "b".repeat(64);

function setup(initial: string | null, opts: { pollMs?: number; retryMs?: number } = {}) {
  const state = { content: initial as string | null, t: 0, reads: 0 };
  const key = createRunnerKey({ file: "/k", ...opts, now: () => state.t,
    read: async () => { state.reads++; if (state.content === null) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return state.content; } });
  return { state, key };
}

test("with no key file every request passes", async () => {
  const { key } = setup(null);
  await key.load();
  assert.equal(await key.allows(undefined), true);
  assert.equal(await key.allows("anything"), true);
});

test("the right key passes; a wrong, missing or array header fails", async () => {
  const { key } = setup(`${A}\n`);
  await key.load();
  assert.equal(await key.allows(A), true);
  assert.equal(await key.allows(B), false);
  assert.equal(await key.allows(undefined), false);
  assert.equal(await key.allows(""), false);
  assert.equal(await key.allows([A] as unknown as string), false);
  assert.equal(await key.allows(A.toUpperCase()), false);
});

test("a wrong key rereads the file, at most once per retryMs", async () => {
  const { key, state } = setup(A, { pollMs: 60_000, retryMs: 1_000 });
  await key.load(); state.content = B;
  state.t = 500;
  assert.equal(await key.allows(B), false, "inside retryMs the old key stays");
  assert.equal(state.reads, 1);
  state.t = 1_000;
  assert.equal(await key.allows(B), true, "after retryMs a mismatch reloads");
  assert.equal(state.reads, 2);
  assert.equal(await key.allows(A), false);
  assert.equal(state.reads, 2, "no reload storm from wrong keys");
});

test("the file is reread after pollMs without a mismatch", async () => {
  const { key, state } = setup(A, { pollMs: 5_000, retryMs: 1_000 });
  await key.load(); state.content = B;
  state.t = 4_999; assert.equal(await key.allows(A), true);
  state.t = 5_000; assert.equal(await key.allows(A), false);
  assert.equal(await key.allows(B), true);
});

test("a deleted key file turns the check off at the next poll", async () => {
  const { key, state } = setup(A, { pollMs: 5_000 });
  await key.load(); state.content = null; state.t = 5_000;
  assert.equal(await key.allows(undefined), true);
});

test("a malformed key file fails closed and reports an invalid fingerprint", async () => {
  for (const content of ["", "short", "g".repeat(64), A + "0", A.toUpperCase(), `${A} ${A}`]) {
    const { key } = setup(content);
    await key.load();
    assert.equal(await key.allows(undefined), false, JSON.stringify(content));
    assert.equal(await key.allows(A), false, JSON.stringify(content));
    assert.equal(await key.fingerprint(), "invalid", JSON.stringify(content));
  }
});
