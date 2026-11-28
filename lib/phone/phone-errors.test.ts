import { test } from "node:test";
import assert from "node:assert/strict";
import { addAgentHelp } from "../agent-help.ts";
import { PhoneInputError, PhoneStateError, phoneInputReply } from "./phone-errors.ts";

test("extra fields never replace the error code or message", () => {
  const reply = phoneInputReply(new PhoneStateError("phone_conflict", "Wait.", { error: "other", message: "other", reason: "state" }));
  assert.equal(reply.body.error, "phone_conflict");
  assert.equal(reply.body.message, "Wait.");
  assert.equal(reply.body.reason, "state");
  assert.deepEqual(phoneInputReply(new PhoneInputError("Bad.")), { status: 400, body: { error: "invalid_input", message: "Bad." } });
});

test("a duplicate codespace asks the user and gets no read-the-phone fix", () => {
  const reply = phoneInputReply(new PhoneStateError("phone_conflict", "Two codespaces.",
    { reason: "duplicate", needs_user: true, user_url: "https://github.com/codespaces" }));
  const helped = addAgentHelp(reply.body, { status: reply.status, pathname: "/v1/phones/p-1", headers: new Headers(), baseUrl: "http://x" });
  assert.equal(helped.needs_user, true);
  assert.equal(helped.user_url, "https://github.com/codespaces");
  assert.equal(helped.fix, undefined);
});
