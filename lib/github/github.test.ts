import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../data/database.ts";
import { createGitHubClient, GitHubError } from "./github.ts";

test("GitHub errors parse retry headers with precedence, preserve rate-limit signals and redact tokens", async t => {
  t.mock.method(Date, "now", () => 1_800_000_000_500);
  const database = new DatabaseSync(":memory:");
  const cases: { headers: Record<string, string>; retryAfter?: number; rateLimited: boolean }[] = [
    { headers: { "retry-after": "17", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000120" }, retryAfter: 17, rateLimited: true },
    { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000120" }, retryAfter: 120, rateLimited: true },
    { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1799999999" }, retryAfter: 0, rateLimited: true },
    { headers: { "retry-after": "0" }, retryAfter: 0, rateLimited: true },
    { headers: { "retry-after": "invalid", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000060" }, retryAfter: 60, rateLimited: true },
    { headers: { "x-ratelimit-remaining": "0" }, rateLimited: true },
    { headers: { "retry-after": "-1" }, rateLimited: true },
    { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "invalid" }, rateLimited: true },
    { headers: { "x-ratelimit-remaining": "1", "x-ratelimit-reset": "1800000120" }, rateLimited: false },
    { headers: {}, rateLimited: false },
  ];
  try {
    migrate(database);
    for (const { headers, retryAfter, rateLimited } of cases) {
      const github = createGitHubClient({ database, accessToken: async () => "synthetic-token",
        fetch: async () => Response.json({ message: "Rejected synthetic-token" }, { status: 403, headers }) });
      await assert.rejects(github.listCodespaces(1), (error: unknown) => {
        assert.ok(error instanceof GitHubError);
        assert.equal(error.status, 403);
        assert.equal(error.message, "Rejected [redacted]");
        assert.equal(error.retryAfter, retryAfter);
        assert.equal(error.rateLimited, rateLimited);
        return true;
      });
    }
  } finally { database.close(); }
});
