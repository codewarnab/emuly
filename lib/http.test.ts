import test from "node:test";
import assert from "node:assert/strict";
import { apiError, errorResponse, json, readJsonObject } from "./http.ts";
import { GitHubError } from "./github/github.ts";
import { RateLimitError } from "./data/rate-limit.ts";

const post = (body: string, type = "application/json") => new Request("https://emuly.dev/v1/x", { method: "POST", body, headers: { "Content-Type": type } });

test("json and apiError are private and use the one error shape", async () => {
  assert.equal(json({ a: 1 }).headers.get("cache-control"), "private, no-store");
  const error = apiError("not_found", "Phone not found.", 404, { "Retry-After": "5" });
  assert.equal(error.status, 404);
  assert.equal(error.headers.get("retry-after"), "5");
  assert.deepEqual(await error.json(), { error: "not_found", message: "Phone not found." });
});

test("errorResponse maps a GitHub refusal to 409 with the account", async () => {
  const response = errorResponse(new GitHubError("Your spending limit has been reached.", 403), "octo", "fallback");
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "github_refused", message: "Your spending limit has been reached.", github_login: "octo" });
});

test("errorResponse maps a rate limit to 429 with Retry-After", async () => {
  const response = errorResponse(new RateLimitError(7), null, "fallback");
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.equal((await response.json()).error, "rate_limited");
});

test("errorResponse gives any other error the fallback message and 502", async () => {
  const response = errorResponse(new Error("secret detail"), null, "Try again.");
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "request_failed", message: "Try again." });
});

test("readJsonObject accepts only a JSON object body", async () => {
  assert.deepEqual((await readJsonObject(post('{"a":1}'))).value, { a: 1 });
  for (const [request, status] of [[post("{}", "text/plain"), 415], [post("{"), 400], [post("[]"), 400], [post("null"), 400]] as const) {
    const { response } = await readJsonObject(request);
    assert.equal(response?.status, status);
    const body = await response!.json();
    assert.equal(body.error, "invalid_input");
    assert.equal(typeof body.message, "string");
  }
});
