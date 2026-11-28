/**
 * Every stable `error` code of the /v1 API. Each has a `## <code>` section in
 * content/skills/emuly-playbook/references/tasks/errors.md, and errors link to it in `docs`.
 * A test fails when the list and the page differ. Never reuse a code for a new meaning.
 */
export const ERROR_CODES = [
  "access_denied", "adb_failed", "adb_timeout", "adb_unavailable", "authorization_pending", "bad_event", "bad_signature", "busy",
  "connection_unavailable", "denied", "direct_upload_unavailable", "expired_token", "forbidden", "github_refused", "invalid_code",
  "invalid_grant", "invalid_input", "invalid_path", "invalid_request", "invalid_response", "limit_reached", "method_not_allowed",
  "not_available", "not_found", "output_too_large", "phone_conflict", "phone_not_ready", "rate_limited", "request_failed",
  "runner_update_required", "slow_down", "staging_full", "storage_full", "timeout", "ui_unavailable", "unauthorized", "unavailable",
  "upload_too_large",
] as const;

export const ERRORS_DOC = "references/tasks/errors.md";
const KNOWN = new Set<string>(ERROR_CODES);
export const isErrorCode = (code: string) => KNOWN.has(code);

/** The docs link for one code, on this server (self-host links stay on the self-host server). */
export const errorDocsUrl = (baseUrl: string, code: string) =>
  `${baseUrl.replace(/\/$/, "")}/.well-known/skills/emuly-playbook/${ERRORS_DOC}#${code}`;
