import type { GitHubError } from "./github.ts";

/**
 * Why GitHub refused a call, as one fixed word. The one sorter for GitHub errors: the API body
 * (lib/phone/github-refused.ts) and the dashboard (lib/shared/sync-error.ts) both use it.
 * GitHub does not document its Codespaces error bodies, so some reasons come from words in the
 * message. A miss gives "other", which was the only reply before.
 */
export type GitHubReason = "billing" | "signed_out" | "sso_required" | "org_blocked" | "no_access"
  | "rate_limited" | "machine_unavailable" | "github_down" | "other";

/** Same words as QUOTA_ERROR_SQL in lib/data/usage.ts. Keep the two in step. */
export const BILLING_WORDS = /spending limit|billing|quota/i;

export function githubReason(error: Pick<GitHubError, "status" | "message" | "rateLimited" | "retryAfter"> & { sso?: string }): GitHubReason {
  const { status, message } = error;
  if (status === 401) return "signed_out";
  if (status === 402 || BILLING_WORDS.test(message)) return "billing";
  if (status === 429 || (status === 403 && (error.rateLimited || error.retryAfter !== undefined || /rate limit/i.test(message)))) return "rate_limited";
  if (status === 403 && (error.sso !== undefined || /SAML|single sign-on/i.test(message))) return "sso_required";
  if (/OAuth App access restrictions/i.test(message)) return "org_blocked";
  if (status === 422 && /machine|location|region/i.test(message)) return "machine_unavailable";
  if (status === 403 || status === 404) return "no_access";
  if (status >= 500) return "github_down";
  return "other";
}

/** The SSO link from GitHub's X-GitHub-SSO header, only when it is a github.com page. */
export function ssoUrl(header: string | null | undefined) {
  const url = /url=(\S+)/.exec(header ?? "")?.[1];
  if (!url) return undefined;
  try { return new URL(url).origin === "https://github.com" ? url : undefined; } catch { return undefined; }
}
