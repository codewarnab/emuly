/**
 * Help for agents in /v1 error replies (docs/agent-experience-plan.md, Phase 1).
 *
 * Every error keeps its `error` code and `message`. This file only adds fields:
 * - `fix`: the next call the agent can make alone, with real ids filled in. Never a key or a token.
 * - `needs_user` / `user_url`: when only the user can do the step.
 * - `retry_after` / `max_retries`: when a retry is the fix.
 * - `if_fix_fails`: the step after a fix that did not work.
 * - `use_cli`: how to install the Emuly CLI, when the caller is not the CLI and not the browser.
 *
 * The route wrapper (lib/diagnostics/api-usage-route.ts) calls `addAgentHelp` on each JSON error,
 * so new routes get the help without extra code. Fields a route already set are never replaced,
 * with one exception: the generic "Phone not found." message gets the phone id (see `not_found`).
 * `docs` links to the section for the code in the skill's errors page.
 */

import { errorDocsUrl, isErrorCode } from "./error-codes.ts";
import { phonePath, waitStopped } from "./phone/phone-not-ready.ts";
import { IDEMPOTENCY_KEY } from "./phone/phone-adb-contract.ts";

export type Fix = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  then?: Fix;
  repeat_until?: Record<string, unknown>;
  every_s?: number;
  max_tries?: number;
};

export type Caller = "cli" | "skill" | "browser" | "powershell" | "curl" | "other";

const ISSUE_URL = "https://github.com/codewarnab/emuly/issues/new";

/**
 * The caller, from headers only. A wrong guess costs one extra field, never a different status.
 * PowerShell's User-Agent starts with "Mozilla/5.0", so it is checked before the browser rule.
 */
export function callerOf(headers: Headers): Caller {
  if (headers.get("x-emuly-client")?.startsWith("cli")) return "cli";
  const agent = headers.get("user-agent") ?? "";
  if (/\b(Windows)?PowerShell\//i.test(agent)) return "powershell";
  if (headers.get("x-emuly-skill")) return "skill";
  const bearer = /^Bearer\s+\S/i.test(headers.get("authorization") ?? "");
  if (!bearer && /^Mozilla\//.test(agent)) return "browser";
  if (/^curl\//i.test(agent)) return "curl";
  return "other";
}

/** The `use_cli` block: how to get the CLI from this same server, for this caller's shell. */
export function useCli(caller: Caller, baseUrl: string, then = "node emuly.mjs login") {
  const base = baseUrl.replace(/\/$/, "");
  return {
    why: "The Emuly CLI signs in, retries and picks the upload route for you, so most of these errors do not happen.",
    install: caller === "powershell"
      ? `Invoke-WebRequest ${base}/v1/cli -OutFile emuly.mjs`
      : `curl -fsSL ${base}/v1/cli -o emuly.mjs`,
    check_sha256: "Compare the file's SHA-256 with the X-Emuly-Cli-Sha256 response header.",
    then,
    needs: "Node 22 or newer. Without Node, ignore this and keep calling the API.",
  };
}

/**
 * Help for an adb command that may have run, when a retry key cannot be trusted: check the screen first.
 * Used without a key, and when the runner gave no `ran` (an old runner ignores the key, so a retry
 * with the same key would run the command again).
 */
export function checkScreenFirst(id: string, keyed: boolean): Record<string, unknown> {
  return {
    fix: { method: "GET", path: `${phonePath(id)}/screenshot` },
    if_fix_fails: keyed ? { same_request: true, same_idempotency_key: true } : { send_again: true, new_idempotency_key: true },
    max_retries: 1,
    hint: keyed
      ? "The command may have run, and this phone may not keep the Idempotency-Key. Check the screen first. Send it again only if the change is not there."
      : "The command may have run. Check the screen first. Send it again only if the change is not there, with an Idempotency-Key header.",
  };
}

/** The phone id in a /v1/phones/{id}/... path, or undefined. */
function phoneIdOf(pathname: string) {
  const id = /^\/v1\/phones\/([^/]+)/.exec(pathname)?.[1];
  if (!id) return undefined;
  try { return decodeURIComponent(id); } catch { return undefined; }
}

const has = (body: Record<string, unknown>, key: string) => body[key] !== undefined;

type HelpContext = { status: number; pathname: string; headers: Headers; baseUrl: string; retryAfter?: string | null };
/** One code's help. `out` is the body being built; `id` is the phone in the path, if any. */
type Helper = (out: Record<string, unknown>, id: string | undefined, context: HelpContext) => void;

/**
 * Adds help fields to one JSON error body. Pure: the same input gives the same output.
 * Order: Retry-After, then the lost-adb-reply help, then the code's own helper, then docs and use_cli.
 */
export function addAgentHelp(body: Record<string, unknown>, context: HelpContext): Record<string, unknown> {
  const code = typeof body.error === "string" ? body.error : undefined;
  if (!code) return body;
  const out: Record<string, unknown> = { ...body };
  const id = phoneIdOf(context.pathname);
  const retry = Number(context.retryAfter);
  if (!has(out, "retry_after") && Number.isFinite(retry) && retry > 0) out.retry_after = retry;
  if (out.ran === "unknown" && id) ranUnknown(out, id, code, context.headers);
  if (Object.hasOwn(HELPERS, code)) HELPERS[code]!(out, id, context);
  if (isErrorCode(code) && !has(out, "docs")) out.docs = errorDocsUrl(context.baseUrl, code);
  const caller = callerOf(context.headers);
  if (caller !== "cli" && caller !== "browser" && !has(out, "use_cli")) {
    out.use_cli = useCli(caller, context.baseUrl, /\/adb(\/upload)?$/.test(context.pathname) || code === "upload_too_large"
      ? `node emuly.mjs install ${id ?? "<phone>"} app.apk` : "node emuly.mjs login");
  }
  return out;
}

/** A lost adb reply: the command may have run. A plain retry could tap or type twice. */
function ranUnknown(out: Record<string, unknown>, id: string, code: string, headers: Headers) {
  if (IDEMPOTENCY_KEY.test(headers.get("idempotency-key") ?? "")) {
    // The runner keeps the first result per key for 10 minutes, so the same key does not run it again.
    out.fix ??= { same_request: true, same_idempotency_key: true };
    out.max_retries ??= 2;
    out.hint ??= "Retry with the same Idempotency-Key: the phone replays the first result and does not run the command again. After a phone restart the key is gone, so check the screen first.";
  } else Object.assign(out, { ...checkScreenFirst(id, false), ...out });
  if (out.retry_after === undefined && code === "request_failed") out.retry_after = 3;
}

/** The help for each code. A code with no entry gets only docs and use_cli. */
const HELPERS: Record<string, Helper> = {
  unauthorized(out, _id, { headers }) {
    const sent = /^Bearer\s+\S/i.test(headers.get("authorization") ?? "")
      || /(^|;\s*)(__Host-)?emuly_session=/.test(headers.get("cookie") ?? "");
    // A bad, revoked or expired key all look the same, on purpose: say nothing about other keys.
    out.reason ??= sent ? "invalid_credentials" : "missing_credentials";
    out.message ??= sent
      ? "This key or session is not valid any more. Sign in again with the device sign-in."
      : "No key was sent. Send Authorization: Bearer <key>, or sign in with the device sign-in.";
    out.fix ??= { method: "POST", path: "/v1/agent/device" };
    out.needs_user ??= true;
  },
  not_found(out, id) {
    // Same reply for a deleted phone, a wrong id and another user's phone. The one replaced field:
    // the generic message becomes one with the id, which the caller sent, so it leaks nothing.
    if (!id || out.message !== "Phone not found.") return;
    out.message = `No phone ${id} on this account. List your phones and use one of their ids.`;
    out.fix ??= { method: "GET", path: "/v1/phones" };
  },
  runner_update_required(out, id) {
    if (!id) return;
    out.fix ??= { method: "POST", path: `${phonePath(id)}/apps/update`, repeat_until: { status: "ready" }, every_s: 3, max_tries: 20 };
    out.if_fix_fails ??= { method: "POST", path: `${phonePath(id)}/stop`, then: waitStopped(id) };
  },
  limit_reached(out) {
    out.needs_user ??= true;
    out.fix ??= { method: "GET", path: "/v1/phones" };
    out.hint ??= "List the phones and reuse one. Ask the user before you delete a phone.";
  },
  phone_conflict(out, id) {
    // A phone in the wrong state for this step: read its state, then do the step that fits it.
    if (id && (out.reason === "state" || out.reason === "unconfirmed")) out.fix ??= { method: "GET", path: phonePath(id) };
    else if (out.reason === "unconfirmed") out.fix ??= { method: "GET", path: "/v1/phones" };
  },
  busy(out) {
    out.max_retries ??= 3;
    out.fix ??= { same_request: true };
  },
  timeout(out) {
    if (out.ran === "unknown") return;
    out.max_retries ??= 2;
    out.fix ??= { same_request: true };
  },
  rate_limited(out) {
    out.hint ??= "Wait retry_after seconds. To wait for a phone, use GET /v1/phones/{id}?wait_for=ready instead of starting it again.";
  },
  request_failed(out) {
    out.report ??= ISSUE_URL;
    if (out.ran === "unknown") return;
    if (!has(out, "retry_after")) out.retry_after = 3;
    out.max_retries ??= 1;
  },
};

/** Error bodies larger than this are passed through unchanged: they are not ours to rewrite. */
export const HELP_BODY_LIMIT = 16 * 1024;

/**
 * Returns `response` with help added, or `response` itself when it is not a JSON error.
 * Status and headers stay the same, except Content-Length, which the new body sets.
 */
export async function withAgentHelp(response: Response, request: Request, baseUrl: string): Promise<Response> {
  if (response.status < 400 || !(response.headers.get("content-type") ?? "").includes("application/json") || !response.body) return response;
  if (Number(response.headers.get("content-length") ?? 0) > HELP_BODY_LIMIT) return response;
  let body: unknown;
  try {
    const text = await response.clone().text();
    if (text.length > HELP_BODY_LIMIT) return response;
    body = JSON.parse(text);
  } catch { return response; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return response;
  const helped = addAgentHelp(body as Record<string, unknown>, {
    status: response.status, pathname: new URL(request.url).pathname, headers: request.headers, baseUrl,
    retryAfter: response.headers.get("retry-after"),
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(helped), { status: response.status, statusText: response.statusText, headers });
}
