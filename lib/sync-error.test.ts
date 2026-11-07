import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubError } from "./github.ts";
import { syncError } from "./sync-error.ts";

test("sync maps expired GitHub sign-in to reconnect", () => {
  assert.deepEqual(syncError(new GitHubError("Bad credentials", 401)), {
    kind: "signin", message: "GitHub sign-in expired.",
  });
});

test("sync maps payment status and quota messages to GitHub billing", () => {
  for (const [status, message] of [[402, "Payment required"], [403, "QUOTA exhausted"],
    [422, "Billing unavailable"], [403, "Spending limit exceeded"]] as const) {
    assert.deepEqual(syncError(new GitHubError(message, status)), {
      kind: "quota", message: "Your Codespaces hours or spending limit ran out.",
    });
  }
});

test("sync maps rate limits to busy and preserves the delay or defaults to one minute", () => {
  for (const error of [new GitHubError("Slow down", 429), new GitHubError("Rate limit exceeded", 403),
    new GitHubError("Forbidden", 403, undefined, true)]) {
    assert.deepEqual(syncError(error), { kind: "busy", message: "GitHub is busy.", retryAfter: 60 });
  }
  for (const seconds of [0, 15, 120]) {
    assert.deepEqual(syncError(new GitHubError("Forbidden", 403, seconds)), {
      kind: "busy", message: "GitHub is busy.", retryAfter: seconds,
    });
  }
});

test("sync shortens and redacts other GitHub errors and keeps the non-GitHub fallback", () => {
  assert.deepEqual(syncError(new GitHubError("Permission denied. More technical details.", 403)), {
    kind: "other", message: "Permission denied.",
  });
  assert.deepEqual(syncError(new GitHubError(`Rejected ghp_${"a".repeat(30)}. Details.`, 500)), {
    kind: "other", message: "Rejected [redacted].",
  });
  assert.deepEqual(syncError(new GitHubError("x".repeat(150), 500)), {
    kind: "other", message: `${"x".repeat(117)}…`,
  });
  for (const error of [new Error("Private network details"), null]) {
    assert.deepEqual(syncError(error), {
      kind: "other", message: "Phone state could not be refreshed. Try again shortly.",
    });
  }
});
