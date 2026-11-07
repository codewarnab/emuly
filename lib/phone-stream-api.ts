import "server-only";
import { issueStreamTicket } from "./phone-stream-ticket.ts";

type Identity = { id: number; sessionId: string };
type Lease = Awaited<ReturnType<Parameters<typeof issueStreamTicket>[0]["open"]>>;
export function createPhoneStreamApi({ user, phone, open }: {
  user: () => Promise<Identity | null>;
  phone: (userId: number, id: string) => { state: string; android_state: string } | undefined;
  open: (userId: number, id: string, sessionId: string) => Promise<Lease>;
}) {
  return async (request: Request, id: string) => {
    const origin = new URL(request.url).origin;
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site") return new Response(null, { status: 403 });
    const identity = await user();
    if (!identity) return new Response(null, { status: 401 });
    const stored = phone(identity.id, id);
    if (!stored) return new Response(null, { status: 404 });
    if (stored.state !== "running" || stored.android_state !== "ready") return new Response(null, { status: 409 });
    try {
      const ticket = issueStreamTicket({ userId: identity.id, phoneId: id, origin, cookie: request.headers.get("cookie") ?? "",
        open: () => open(identity.id, id, identity.sessionId) });
      return Response.json({ ticket }, { headers: { "Cache-Control": "private, no-store" } });
    } catch { return new Response(null, { status: 503 }); }
  };
}
