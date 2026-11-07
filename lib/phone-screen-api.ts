import "server-only";
import type { RunnerPath } from "./phone-link.ts";

type ScreenPhone = { state: string; android_state: string };
/** Session identity and ownership are checked on every frame and input request. */
export function createPhoneScreenApi({ user, phone, runner }: {
  user: () => Promise<{ id: number } | null>;
  phone: (userId: number, id: string) => ScreenPhone | undefined;
  runner: (userId: number, id: string, path: RunnerPath, body?: Record<string, unknown>) => Promise<Response>;
}) {
  const json = (error: string, status: number) => Response.json({ error }, { status, headers: { "Cache-Control": "private, no-store" } });
  return async function screen(request: Request, id: string) {
    const identity = await user();
    if (!identity) return json("Sign in again.", 401);
    const stored = phone(identity.id, id);
    if (!stored) return json("Phone not found.", 404);
    if (stored.state !== "running" || stored.android_state !== "ready") return json("Android is not ready.", 409);
    if (request.method === "POST") {
      const origin = request.headers.get("origin");
      if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") return json("Forbidden.", 403);
      if (!request.headers.get("content-type")?.startsWith("application/json")) return json("Expected JSON.", 415);
      try {
        // Inputs are tiny. Bound the body even when Content-Length is absent.
        const reader = request.body?.getReader();
        if (!reader) return json("Invalid input.", 400);
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 1024) { await reader.cancel(); return json("Input too large.", 413); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!input || typeof input !== "object") return json("Invalid input.", 400);
        if (input.type === "tap" && [input.x, input.y].every(n => Number.isInteger(n) && n >= 0 && n <= 10000)) {
          await runner(identity.id, id, "/tap", { x: input.x, y: input.y });
        } else if (input.type === "key" && ["home", "back"].includes(input.key)) {
          await runner(identity.id, id, "/key", { key: input.key });
        } else return json("Invalid input.", 400);
        return Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
      } catch (error) { return json(error instanceof SyntaxError ? "Invalid JSON." : "Phone input failed. Try again.", error instanceof SyntaxError ? 400 : 502); }
    }
    if (request.method !== "GET") return json("Method not allowed.", 405);
    try {
      const response = await runner(identity.id, id, "/screenshot");
      const bytes = await response.arrayBuffer();
      if (!response.ok || !response.headers.get("content-type")?.startsWith("image/png") ||
        Buffer.from(bytes).subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Invalid screenshot");
      return new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff" } });
    } catch { return json("Screen unavailable. Retrying…", 502); }
  };
}
