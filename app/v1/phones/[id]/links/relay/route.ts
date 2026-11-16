import { upgradeWebSocket } from "@vercel/functions";
import { LinkTicketError, openLinkRelay } from "../../../../../../lib/phone/link-relay-open";
import { RELAY_MAX_PAYLOAD } from "../../../../../../lib/phone/phone-links-contract";

// Route B relay on the hosted control plane. A function ends after 300 s, so the relay ends at
// 280 s with code 4012 and `emuly link` reconnects with a new ticket. Self-host serves the same
// path in lib/phone/phone-stream-proxy.mjs, with no time limit.
export const maxDuration = 300;
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const ticket = new URL(request.url).searchParams.get("ticket") ?? "";
  let relay: Awaited<ReturnType<typeof openLinkRelay>>;
  try { relay = await openLinkRelay(id, ticket); }
  catch (error) { return new Response(null, { status: error instanceof LinkTicketError ? 403 : 503 }); }
  try {
    return await upgradeWebSocket(socket => relay.attach(socket, 280_000), { maxPayload: RELAY_MAX_PAYLOAD });
  } catch { relay.cancel(); return new Response(null, { status: 503 }); }
}
