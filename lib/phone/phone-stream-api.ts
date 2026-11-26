import "server-only";
import { NO_STORE, apiError } from "../http.ts";
import { crossOrigin } from "../auth/origin.ts";
import { issueStreamTicket } from "./phone-stream-ticket.ts";

type Identity = { id: number; sessionId: string };
type Direct = (input: { userId: number; phoneId: string; codespaceName: string; sessionId: string; quality: string; origin: string }) =>
  Promise<{ url: string; ticket: string } | undefined>;
const QUALITIES = new Set(["auto", "sharp", "saver"]);
type Lease = Awaited<ReturnType<Parameters<typeof issueStreamTicket>[0]["open"]>>;
type StoredPhone = { state: string; android_state: string; codespace_name?: string | null };
const EMPTY_ERRORS: Record<number, [string, string]> = {
  400: ["invalid_input", "The request body is not valid."], 401: ["unauthorized", "Sign in again."],
  403: ["forbidden", "This request must come from the Emuly page."], 404: ["not_found", "Phone not found."],
  405: ["method_not_allowed", "Use POST."], 409: ["phone_not_ready", "The phone is not running."],
  413: ["upload_too_large", "The request body is too large."], 415: ["invalid_input", "Send the body as application/json."],
  503: ["request_failed", "The stream could not start. Try again."],
};

export function createPhoneStreamApi({ user, phone, open, observation, issue, direct }: {
  user: () => Promise<Identity | null>;
  phone: (userId: number, id: string) => StoredPhone | undefined | Promise<StoredPhone | undefined>;
  direct?: Direct;
  open: (userId: number, id: string, sessionId: string) => Promise<Lease>;
  issue?: (ticket: { userId: number; phoneId: string; sessionId: string; origin: string; cookie: string }) => Promise<string>;
  observation?: (userId: number, id: string) => string | undefined | Promise<string | undefined>;
}) {
  return async (request: Request, id: string) => {
    const origin = new URL(request.url).origin;
    if (request.method !== "POST") return apiError(...EMPTY_ERRORS[405]!, 405);
    if (crossOrigin(request, "session", { requireOrigin: true })) return apiError(...EMPTY_ERRORS[403]!, 403);
    const identity = await user();
    if (!identity) return apiError(...EMPTY_ERRORS[401]!, 401);
    const stored = await phone(identity.id, id);
    if (!stored) return apiError(...EMPTY_ERRORS[404]!, 404);
    // GitHub reports ShuttingDown/Shutdown/Queued while the forwarded port may still answer /health.
    // A retry or tunnel cannot work then, so give the page a distinct code it can show as "Phone stopped".
    if (stored.state !== "running") return Response.json({ errorCode: "phone_stopped" }, { status: 409 });
    if (stored.android_state !== "ready") return apiError(...EMPTY_ERRORS[409]!, 409);
    try {
      const cookie = request.headers.get("cookie") ?? "";
      const asked = new URL(request.url).searchParams.get("quality") ?? "auto";
      const quality = QUALITIES.has(asked) ? asked : "auto";
      // The three steps do not depend on each other, so their Turso and GitHub waits overlap.
      // Phase 4: a direct ticket for port 8791. The browser tries it first and falls back to `ticket`.
      // A direct failure only drops the direct path; a ticket or observation failure is a 503.
      const [ticket, attemptId, directStream] = await Promise.all([
        issue ? issue({ userId: identity.id, phoneId: id, sessionId: identity.sessionId, origin, cookie })
          : issueStreamTicket({ userId: identity.id, phoneId: id, origin, cookie, open: () => open(identity.id, id, identity.sessionId) }),
        observation?.(identity.id, id),
        direct && stored.codespace_name
          ? direct({ userId: identity.id, phoneId: id, codespaceName: stored.codespace_name, sessionId: identity.sessionId, quality, origin }).catch(() => undefined)
          : undefined,
      ]);
      return Response.json({ ticket, ...(attemptId ? { attemptId } : {}), ...(directStream ? { direct: directStream } : {}) }, { headers: { "Cache-Control": NO_STORE } });
    } catch { return apiError(...EMPTY_ERRORS[503]!, 503); }
  };
}
