import { GitHubError } from "./github/github.ts";
import { RateLimitError } from "./data/rate-limit.ts";
import { githubRefused } from "./phone/github-refused.ts";

/** Every API response is private to one account. */
export const NO_STORE = "private, no-store";

/** A JSON response that no cache keeps. */
export function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": NO_STORE, ...headers } });
}

/** The one error shape of every API route: `error` is a stable code, `message` is for people. */
export function apiError(code: string, message: string, status: number, headers?: Record<string, string>): Response {
  return json({ error: code, message }, status, headers);
}

/**
 * The response for an error that many routes share. A GitHub refusal is 409 with the account that
 * GitHub refused. A rate limit is 429 with Retry-After. Any other error gets `fallback` and 502.
 */
export function errorResponse(error: unknown, login: string | null | undefined, fallback: string): Response {
  if (error instanceof GitHubError) return json(githubRefused(error, login), 409);
  if (error instanceof RateLimitError) return apiError("rate_limited", error.message, 429, { "Retry-After": String(error.retryAfter) });
  return apiError("request_failed", fallback, 502);
}

/** A plain JSON object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a JSON object body. A wrong content type is 415. Bad JSON or a body that is not a plain
 * object is 400. The caller returns `response` when it is set.
 */
export async function readJsonObject(request: Request):
  Promise<{ value: Record<string, unknown>; response?: undefined } | { value?: undefined; response: Response }> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return { response: apiError("invalid_input", "Send the body as application/json.", 415) };
  }
  let value: unknown;
  try { value = await request.json(); }
  catch { return { response: apiError("invalid_input", "The body is not valid JSON.", 400) }; }
  if (!isRecord(value)) return { response: apiError("invalid_input", "Expected a JSON object.", 400) };
  return { value };
}
