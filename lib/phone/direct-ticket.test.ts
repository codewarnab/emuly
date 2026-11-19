import { test } from "node:test";
import assert from "node:assert/strict";
import { directKeyFile, issueDirectTicket, phoneDirectKey } from "./direct-ticket.ts";
import { createNonceStore, createRateLimiter, signTicket, verifyTicket } from "../../phone/runner/direct-ticket.mjs";

const SECRET = "s".repeat(40);
const NOW = 1_800_000_000_000;
const input = { codespaceName: "phone-a", phoneId: "ph_a", userId: 7, sessionId: "sess", quality: "auto", origin: "https://emuly.vercel.app" };
const key = phoneDirectKey("phone-a", SECRET)!;
const check = (ticket: string | undefined, over: Partial<{ codespace: string; origin: string; now: number; nonces: ReturnType<typeof createNonceStore> }> = {}) =>
  verifyTicket(key, ticket, { codespace: "phone-a", origin: input.origin, nonces: createNonceStore(), now: NOW, ...over });

test("a valid ticket passes and carries the user", () => {
  const result = check(issueDirectTicket(input, { secret: SECRET, now: NOW }));
  assert.equal(result.ok, true);
  assert.equal(result.payload.userId, 7);
  assert.equal(result.payload.phoneId, "ph_a");
});

test("an expired ticket fails", () => {
  assert.deepEqual(check(issueDirectTicket(input, { secret: SECRET, now: NOW - 31_000 })), { ok: false, reason: "expired" });
});

test("a ticket with a far future expiry fails", () => {
  const ticket = signTicket(key, { codespace: "phone-a", origin: input.origin, nonce: "n".repeat(24), exp: NOW + 3_600_000 });
  assert.equal(check(ticket).reason, "expired");
});

test("a ticket for another phone fails on this phone", () => {
  const other = issueDirectTicket({ ...input, codespaceName: "phone-b" }, { secret: SECRET, now: NOW });
  assert.equal(check(other).reason, "signature");
  // Same key but a different codespace name in the signed payload.
  const ticket = signTicket(key, { codespace: "phone-b", origin: input.origin, nonce: "n".repeat(24), exp: NOW + 10_000 });
  assert.equal(check(ticket).reason, "phone");
});

test("a bad or changed signature fails", () => {
  const ticket = issueDirectTicket(input, { secret: SECRET, now: NOW })!;
  const [part, sig] = ticket.split(".");
  assert.equal(check(`${part}.${sig.slice(0, -2)}AA`).reason, "signature");
  assert.equal(check(`${part}.`).reason, "signature");
  const otherKey = issueDirectTicket(input, { secret: "t".repeat(40), now: NOW });
  assert.equal(check(otherKey).reason, "signature");
});

test("a changed field fails", () => {
  const ticket = issueDirectTicket(input, { secret: SECRET, now: NOW })!;
  const [part, sig] = ticket.split(".");
  const payload = JSON.parse(Buffer.from(part, "base64url").toString());
  payload.userId = 8;
  assert.equal(check(`${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`).reason, "signature");
});

test("a reused nonce fails", () => {
  const nonces = createNonceStore();
  const ticket = issueDirectTicket(input, { secret: SECRET, now: NOW });
  assert.equal(check(ticket, { nonces }).ok, true);
  assert.equal(check(ticket, { nonces }).reason, "replay");
});

test("a wrong or missing Origin fails", () => {
  assert.equal(check(issueDirectTicket(input, { secret: SECRET, now: NOW }), { origin: "https://evil.example" }).reason, "origin");
  assert.equal(check(issueDirectTicket(input, { secret: SECRET, now: NOW }), { origin: undefined as unknown as string }).reason, "origin");
});

test("malformed tickets fail with no throw", () => {
  for (const value of [undefined, "", "abc", "a.b.c", "x".repeat(3000), 42]) assert.equal(check(value as string).ok, false);
});

test("a full nonce store refuses new tickets", () => {
  const nonces = createNonceStore(1);
  assert.equal(nonces.claim("a".repeat(16), NOW + 1000, NOW), true);
  assert.equal(nonces.claim("b".repeat(16), NOW + 1000, NOW), false);
  assert.equal(nonces.claim("b".repeat(16), NOW + 1000, NOW + 2000), true);
});

test("the rate limit allows 20 tries a minute per address", () => {
  const allow = createRateLimiter({ max: 20, windowMs: 60_000 });
  for (let i = 0; i < 20; i++) assert.equal(allow("1.2.3.4", NOW), true);
  assert.equal(allow("1.2.3.4", NOW), false);
  assert.equal(allow("5.6.7.8", NOW), true);
  assert.equal(allow("1.2.3.4", NOW + 60_000), true);
});

test("no secret or a short secret gives no key and no ticket", () => {
  assert.equal(phoneDirectKey("phone-a", ""), undefined);
  assert.equal(phoneDirectKey("phone-a", "short"), undefined);
  assert.equal(issueDirectTicket(input, { secret: "" }), undefined);
  assert.equal(directKeyFile("bad name;rm", SECRET), undefined);
  assert.notEqual(phoneDirectKey("phone-a", SECRET), phoneDirectKey("phone-b", SECRET));
  assert.match(directKeyFile("phone-a", SECRET)!, /^[0-9a-f]{64}\nphone-a\n$/);
});
