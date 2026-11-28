import type { GitHubError } from "../github/github.ts";
import { githubReason } from "../github/github-reason.ts";
import { GITHUB_BILLING_URL } from "../shared/plans.ts";
import { redact } from "./phone-mutations.ts";

/**
 * The body for a GitHub refusal. github_login names the account GitHub refused, such as a billing block.
 * `reason` says why, so an agent knows whether to wait, retry or ask the user. The status stays 409.
 */
export function githubRefused(error: GitHubError, login?: string | null) {
  const reason = githubReason(error);
  const body: Record<string, unknown> = { error: "github_refused", reason, message: redact(error.message), ...(login ? { github_login: login } : {}) };
  switch (reason) {
    case "billing":
      Object.assign(body, { needs_user: true, user_url: GITHUB_BILLING_URL,
        hint: "GitHub refused for billing: the Codespaces hours or spending limit ran out. Ask the user to raise the limit or wait for next month." });
      break;
    case "signed_out":
      Object.assign(body, { needs_user: true, fix: { method: "POST", path: "/v1/agent/device" } });
      break;
    case "sso_required":
      Object.assign(body, { needs_user: true, ...(error.sso ? { user_url: error.sso } : {}),
        hint: "The organization needs a SAML single sign-on for Emuly. Ask the user to open user_url and sign in." });
      break;
    case "org_blocked":
      Object.assign(body, { needs_user: true, user_url: "https://github.com/settings/applications",
        hint: "The organization blocks Emuly. Ask the user to request org access for Emuly, or use a repository outside it." });
      break;
    case "no_access":
    case "machine_unavailable":
      body.needs_user = true;
      break;
    case "rate_limited":
      Object.assign(body, { retry_after: error.retryAfter && error.retryAfter > 0 ? error.retryAfter : 60, max_retries: 2, fix: { same_request: true } });
      break;
    case "github_down":
      Object.assign(body, { retry_after: 30, max_retries: 2, fix: { same_request: true } });
      break;
  }
  return body;
}

/** The Retry-After header for a refusal body, when a retry is the fix. */
export function githubRefusedHeaders(body: Record<string, unknown>): Record<string, string> | undefined {
  return typeof body.retry_after === "number" ? { "Retry-After": String(body.retry_after) } : undefined;
}
