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
 * so new routes get the help without extra code. Fields a route already set are never replaced.
 */

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
const phonePath = (id: string) => `/v1/phones/${encodeURIComponent(id)}`;
const waitReady = (id: string): Fix => ({ method: "GET", path: `${phonePath(id)}?wait_for=ready&timeout_s=60` });
const waitStopped = (id: string): Fix => ({ method: "GET", path: `${phonePath(id)}?wait_for=stopped&timeout_s=60` });

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

type Stored = { state: string; android_state: string };

/**
 * The phone_not_ready reply. The next step depends on the state: a booting phone needs only a wait,
 * and a start sent then is wasted and counts toward the rate limit.
 */
export function phoneNotReady(id: string, stored: Stored): { body: Record<string, unknown>; headers?: Record<string, string> } {
  const base = { error: "phone_not_ready", state: stored.state, android_state: stored.android_state };
  if (stored.state === "deleted") {
    return { body: { ...base, message: "This phone was deleted. Create a new phone.", fix: { method: "POST", path: "/v1/phones" } } };
  }
  if (stored.state === "stopped" || stored.state === "error" || (stored.state === "running" && stored.android_state === "failed")) {
    const start = { method: "POST", path: `${phonePath(id)}/start`, then: waitReady(id) };
    return { body: { ...base, message: `The phone is ${stored.state} with Android ${stored.android_state}. Start it, wait until ready, then retry.`, fix: start } };
  }
  if (stored.state === "stopping") {
    return { body: { ...base, message: "The phone is stopping. Wait until it is stopped, then start it.", retry_after: 10,
      fix: { ...waitStopped(id), then: { method: "POST", path: `${phonePath(id)}/start`, then: waitReady(id) } } },
    headers: { "Retry-After": "10" } };
  }
  // Starting, or running while Android boots: only wait. Do not send another start.
  return { body: { ...base, message: `The phone is ${stored.state} with Android ${stored.android_state}. Wait until ready, then retry. Do not start it again.`,
    retry_after: 10, fix: waitReady(id) }, headers: { "Retry-After": "10" } };
}

/** The phone id in a /v1/phones/{id}/... path, or undefined. */
function phoneIdOf(pathname: string) {
  const id = /^\/v1\/phones\/([^/]+)/.exec(pathname)?.[1];
  if (!id) return undefined;
  try { return decodeURIComponent(id); } catch { return undefined; }
}

const has = (body: Record<string, unknown>, key: string) => body[key] !== undefined;

/**
 * Adds help fields to one JSON error body. Pure: the same input gives the same output.
 * `retryAfter` is the Retry-After header of the reply, if any.
 */
export function addAgentHelp(body: Record<string, unknown>, context: {
  status: number; pathname: string; headers: Headers; baseUrl: string; retryAfter?: string | null;
}): Record<string, unknown> {
  const code = typeof body.error === "string" ? body.error : undefined;
  if (!code) return body;
  const out: Record<string, unknown> = { ...body };
  const id = phoneIdOf(context.pathname);
  const caller = callerOf(context.headers);
  const retry = Number(context.retryAfter);
  if (!has(out, "retry_after") && Number.isFinite(retry) && retry > 0) out.retry_after = retry;

  // A lost adb reply: the command may have run. A plain retry could tap or type twice.
  if (out.ran === "unknown" && id) {
    const keyed = /^[\w.:-]{1,100}$/.test(context.headers.get("idempotency-key") ?? "");
    if (keyed) {
      // The runner keeps the first result per key for 10 minutes, so the same key does not run it again.
      out.fix ??= { same_request: true, same_idempotency_key: true };
      out.max_retries ??= 2;
      out.hint ??= "Retry with the same Idempotency-Key: the phone replays the first result and does not run the command again. After a phone restart the key is gone, so check the screen first.";
    } else {
      out.fix ??= { method: "GET", path: `${phonePath(id)}/screenshot` };
      out.if_fix_fails ??= { send_again: true, new_idempotency_key: true };
      out.max_retries ??= 1;
      out.hint ??= "The command may have run. Check the screen first. Send it again only if the change is not there, with an Idempotency-Key header.";
    }
    if (out.retry_after === undefined && code === "request_failed") out.retry_after = 3;
  }

  switch (code) {
    case "unauthorized": {
      const sent = /^Bearer\s+\S/i.test(context.headers.get("authorization") ?? "")
        || /(^|;\s*)(__Host-)?emuly_session=/.test(context.headers.get("cookie") ?? "");
      // A bad, revoked or expired key all look the same, on purpose: say nothing about other keys.
      out.reason ??= sent ? "invalid_credentials" : "missing_credentials";
      out.message ??= sent
        ? "This key or session is not valid any more. Sign in again with the device sign-in."
        : "No key was sent. Send Authorization: Bearer <key>, or sign in with the device sign-in.";
      out.fix ??= { method: "POST", path: "/v1/agent/device" };
      out.needs_user ??= true;
      break;
    }
    case "not_found":
      // Same reply for a deleted phone, a wrong id and another user's phone.
      if (id && out.message === "Phone not found.") {
        out.message = `No phone ${id} on this account. List your phones and use one of their ids.`;
        out.fix ??= { method: "GET", path: "/v1/phones" };
      }
      break;
    case "runner_update_required":
      if (id) {
        out.fix ??= { method: "POST", path: `${phonePath(id)}/apps/update`, repeat_until: { status: "ready" }, every_s: 3, max_tries: 20 };
        out.if_fix_fails ??= { method: "POST", path: `${phonePath(id)}/stop`, then: waitStopped(id) };
      }
      break;
    case "busy":
      out.max_retries ??= 3;
      out.fix ??= { same_request: true };
      break;
    case "timeout":
      if (out.ran === "unknown") break;
      out.max_retries ??= 2;
      out.fix ??= { same_request: true };
      break;
    case "rate_limited":
      out.hint ??= "Wait retry_after seconds. To wait for a phone, use GET /v1/phones/{id}?wait_for=ready instead of starting it again.";
      break;
    case "request_failed":
      if (out.ran === "unknown") { out.report ??= ISSUE_URL; break; }
      if (!has(out, "retry_after")) out.retry_after = 3;
      out.max_retries ??= 1;
      out.report ??= ISSUE_URL;
      break;
  }

  if (caller !== "cli" && caller !== "browser" && !has(out, "use_cli")) {
    out.use_cli = useCli(caller, context.baseUrl, /\/adb(\/upload)?$/.test(context.pathname) || code === "upload_too_large"
      ? `node emuly.mjs install ${id ?? "<phone>"} app.apk` : "node emuly.mjs login");
  }
  return out;
}

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
