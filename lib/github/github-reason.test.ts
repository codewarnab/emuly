import test from "node:test";
import assert from "node:assert/strict";
import { GitHubError } from "./github.ts";
import { BILLING_WORDS, githubReason, ssoUrl, githubRetryAfter } from "./github-reason.ts";
import { githubRefused, githubRefusedHeaders } from "../phone/github-refused.ts";
import { QUOTA_ERROR_SQL } from "../data/usage.ts";

test("githubReason sorts each kind of GitHub refusal", () => {
  const cases: [GitHubError, string][] = [
    [new GitHubError("Bad credentials", 401), "signed_out"],
    [new GitHubError("Payment required", 402), "billing"],
    [new GitHubError("Your spending limit has been reached.", 403), "billing"],
    [new GitHubError("There is a billing issue that is preventing you from starting this codespace.", 400), "billing"],
    [new GitHubError("API rate limit exceeded", 403), "rate_limited"],
    [new GitHubError("Forbidden", 403, 30, true), "rate_limited"],
    [new GitHubError("Too many", 429), "rate_limited"],
    [new GitHubError("Resource protected by organization SAML enforcement.", 403), "sso_required"],
    [new GitHubError("Forbidden", 403, undefined, false, "https://github.com/orgs/acme/sso?authorization_request=x"), "sso_required"],
    [new GitHubError("Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions", 403), "org_blocked"],
    [new GitHubError("Machine type is not available in this location", 422), "machine_unavailable"],
    [new GitHubError("Not Found", 404), "no_access"],
    [new GitHubError("Forbidden", 403), "no_access"],
    [new GitHubError("Server Error", 502), "github_down"],
    [new GitHubError("Validation Failed", 422), "other"],
  ];
  for (const [error, reason] of cases) assert.equal(githubReason(error), reason, error.message);
});

test("billing words match the stored-message SQL", () => {
  for (const word of ["spending limit", "billing", "quota"]) {
    assert.ok(BILLING_WORDS.test(word));
    assert.ok(QUOTA_ERROR_SQL.includes(`%${word}%`), word);
  }
});

test("ssoUrl keeps only github.com links", () => {
  assert.equal(ssoUrl("required; url=https://github.com/orgs/acme/sso?authorization_request=abc"), "https://github.com/orgs/acme/sso?authorization_request=abc");
  assert.equal(ssoUrl("required; url=https://evil.example/sso"), undefined);
  assert.equal(ssoUrl("partial-results; organizations=1,2"), undefined);
  assert.equal(ssoUrl(null), undefined);
});

test("githubRefused gives a reason, user steps, and a retry only when a retry helps", () => {
  const limited = githubRefused(new GitHubError("API rate limit exceeded", 403, 42, true));
  assert.equal(limited.reason, "rate_limited");
  assert.equal(limited.retry_after, 42);
  assert.deepEqual(githubRefusedHeaders(limited), { "Retry-After": "42" });
  const billing = githubRefused(new GitHubError("Your spending limit has been reached.", 403), "octo");
  assert.equal(billing.needs_user, true);
  assert.equal(billing.fix, undefined);
  assert.equal(billing.retry_after, undefined);
  assert.equal(githubRefusedHeaders(billing), undefined);
  const sso = githubRefused(new GitHubError("Forbidden", 403, undefined, false, "https://github.com/orgs/acme/sso"));
  assert.equal(sso.user_url, "https://github.com/orgs/acme/sso");
  assert.deepEqual(githubRefused(new GitHubError("Bad credentials", 401)).fix, { method: "POST", path: "/v1/agent/device" });
  assert.equal(githubRefused(new GitHubError("Validation Failed", 422)).reason, "other");
});

test("githubRetryAfter uses GitHub's wait only when it is above 0", () => {
  assert.equal(githubRetryAfter({ retryAfter: 12 }), 12);
  assert.equal(githubRetryAfter({ retryAfter: 0 }), 60);
  assert.equal(githubRetryAfter({ retryAfter: undefined }), 60);
});
