import { diagnosticHealth } from "./diagnostics.ts";
import type { phoneObservations } from "./phone-observation.ts";

/** Write-only observation endpoint. Identity comes exclusively from the authenticated session. */
export function createDiagnosticBrowserApi({ user, phone, observations }: {
  user: () => Promise<{ id: number } | null>;
  phone: (userId: number, phoneId: string) => { state: string } | undefined;
  observations: ReturnType<typeof phoneObservations>;
}) {
  return async (request: Request, id: string) => {
    const response = (status: number) => new Response(null, { status, headers: { "Cache-Control": "private, no-store" } });
    if (request.method !== "POST") return response(405);
    if (request.headers.get("origin") !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") return response(403);
    const owner = await user();
    if (!owner) return response(401);
    const stored = phone(owner.id, id);
    if (!stored) return response(404);
    if (!["running", "booting"].includes(stored.state)) return response(409);
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
      return response(observations.ingest({ userId: owner.id, id }, value) ? 204 : 400);
    } catch { diagnosticHealth.invalidRecords++; return response(400); }
    finally { reader.releaseLock(); }
  };
}
