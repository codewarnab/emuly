import { createHash } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { asyncDb } from "../data/async-db";
import { createApiUsage, errorOf } from "./api-usage";

// One recorder per function instance. On Vercel, waitUntil keeps the instance alive for the flush
// after the response is sent, so a request never waits for it.
const usage = createApiUsage(asyncDb, task => { if (process.env.VERCEL) waitUntil(task); });

/**
 * Wraps a /v1 route handler to count the call anonymously (see api-usage.ts).
 * The handler runs exactly as before. The wrapper only reads the status and the time,
 * and for a JSON error it reads the `error` code from a copy of the body, in the background.
 */
export function withApiUsage<C>(handler: (request: Request, context: C) => Response | Promise<Response>) {
  return async (request: Request, context: C): Promise<Response> => {
    if (process.env.EMULY_DIAGNOSTICS !== "1") return handler(request, context);
    const started = performance.now();
    const { pathname } = new URL(request.url);
    // The caller hash only groups calls for the pattern detector, in memory. It is never stored.
    const credential = request.headers.get("authorization") ?? /emuly_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1] ?? "";
    const caller = credential ? createHash("sha256").update(credential).digest("base64url").slice(0, 16) : "";
    const count = (status: number, error?: unknown) => usage.record({ method: request.method, pathname, headers: request.headers,
      status, durationMs: performance.now() - started, error }, caller);
    let response: Response;
    try { response = await handler(request, context); }
    catch (error) { count(500); throw error; }
    try {
      if (response.status >= 400 && (response.headers.get("content-type") ?? "").includes("application/json") && response.body) {
        const durationMs = performance.now() - started;
        const read = response.clone().json().then((body: { error?: unknown }) => errorOf(body?.error), () => "other")
          .then(error => usage.record({ method: request.method, pathname, headers: request.headers, status: response.status, durationMs, error }, caller));
        if (process.env.VERCEL) waitUntil(read);
      } else count(response.status);
    } catch { /* Counting never changes the response. */ }
    return response;
  };
}
