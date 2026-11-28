import { apiError, NO_STORE } from "../http.ts";
import { crossOrigin } from "../auth/origin.ts";
import { phoneNotReady } from "../phone/phone-not-ready.ts";
import { diagnosticHealth } from "./diagnostics.ts";
import type { phoneObservations } from "../phone/phone-observation.ts";

/** Write-only observation endpoint. Identity comes exclusively from the authenticated session. */
const EMPTY_ERRORS: Record<number, [string, string]> = {
  400: ["invalid_input", "The request body is not valid."], 401: ["unauthorized", "Sign in again."],
  403: ["forbidden", "This request must come from the Emuly page."], 404: ["not_found", "Phone not found."],
  405: ["method_not_allowed", "Use POST."], 409: ["phone_not_ready", "The phone is not running."],
  413: ["upload_too_large", "The request body is too large."], 415: ["invalid_input", "Send the body as application/json."],
  503: ["request_failed", "The stream could not start. Try again."],
};

export function createDiagnosticBrowserApi({ user, phone, observations }: {
  user: () => Promise<{ id: number } | null>;
  phone: (userId: number, phoneId: string) => { state: string; android_state?: string } | undefined | Promise<{ state: string; android_state?: string } | undefined>;
  observations: ReturnType<typeof phoneObservations>;
}) {
  return async (request: Request, id: string) => {
    const response = (status: number) => status < 300 ? new Response(null, { status, headers: { "Cache-Control": NO_STORE } })
      : apiError(...EMPTY_ERRORS[status]!, status);
    if (request.method !== "POST") return response(405);
    if (crossOrigin(request, "session", { requireOrigin: true })) return response(403);
    const owner = await user();
    if (!owner) return response(401);
    const stored = await phone(owner.id, id);
    if (!stored) return response(404);
    if (!["running", "booting"].includes(stored.state)) {
      const notReady = phoneNotReady(id, { state: stored.state, android_state: stored.android_state ?? "unknown" });
      return Response.json(notReady.body, { status: 409, headers: { "Cache-Control": NO_STORE, ...notReady.headers } });
    }
    if (!request.headers.get("content-type")?.startsWith("application/json")) return response(415);
    const reader = request.body?.getReader();
    if (!reader) return response(400);
    try {
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 1024) { await reader.cancel(); return response(413); }
        chunks.push(value);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return response(await observations.ingest({ userId: owner.id, id }, value) ? 204 : 400);
    } catch { diagnosticHealth.invalidRecords++; return response(400); }
    finally { reader.releaseLock(); }
  };
}
