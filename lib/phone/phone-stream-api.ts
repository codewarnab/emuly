import "server-only";
import { issueStreamTicket } from "./phone-stream-ticket.ts";

type Identity = { id: number; sessionId: string };
type Direct = (input: { userId: number; phoneId: string; codespaceName: string; sessionId: string; quality: string; origin: string }) =>
  Promise<{ url: string; ticket: string } | undefined>;
const QUALITIES = new Set(["auto", "sharp", "saver"]);
type Lease = Awaited<ReturnType<Parameters<typeof issueStreamTicket>[0]["open"]>>;
type StoredPhone = { state: string; android_state: string; codespace_name?: string | null };
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
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site") return new Response(null, { status: 403 });
    const identity = await user();
    if (!identity) return new Response(null, { status: 401 });
    const stored = await phone(identity.id, id);
    if (!stored) return new Response(null, { status: 404 });
    // GitHub reports ShuttingDown/Shutdown/Queued while the forwarded port may still answer /health.
    // A retry or tunnel cannot work then, so give the page a distinct code it can show as "Phone stopped".
    if (stored.state !== "running") return Response.json({ errorCode: "phone_stopped" }, { status: 409 });
    if (stored.android_state !== "ready") return new Response(null, { status: 409 });
    try {
      const ticket = issue ? await issue({ userId: identity.id, phoneId: id, sessionId: identity.sessionId, origin, cookie: request.headers.get("cookie") ?? "" }) : issueStreamTicket({ userId: identity.id, phoneId: id, origin, cookie: request.headers.get("cookie") ?? "",
        open: () => open(identity.id, id, identity.sessionId) });
      const attemptId = await observation?.(identity.id, id);
      // Phase 4: a direct ticket for port 8791. The browser tries it first and falls back to `ticket`.
      const asked = new URL(request.url).searchParams.get("quality") ?? "auto";
      const quality = QUALITIES.has(asked) ? asked : "auto";
      const directStream = direct && stored.codespace_name
        ? await direct({ userId: identity.id, phoneId: id, codespaceName: stored.codespace_name, sessionId: identity.sessionId, quality, origin }).catch(() => undefined)
        : undefined;
      return Response.json({ ticket, ...(attemptId ? { attemptId } : {}), ...(directStream ? { direct: directStream } : {}) }, { headers: { "Cache-Control": "private, no-store" } });
    } catch { return new Response(null, { status: 503 }); }
  };
}
