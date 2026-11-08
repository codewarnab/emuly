import { upgradeWebSocket, waitUntil } from "@vercel/functions";
import { asyncDb } from "../../../../../../lib/data/async-db";
import { takeSharedStreamTicket } from "../../../../../../lib/phone/shared-stream-ticket";
import { servePngFrames } from "../../../../../../lib/phone/png-stream";
import { runnerFrame } from "../../../../../../lib/phone/runner-frame";

export const maxDuration = 300;
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const origin = request.headers.get("origin") ?? "";
  if (origin !== url.origin || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 403 });
  try {
    const ticket = await takeSharedStreamTicket(asyncDb(), url.searchParams.get("ticket") ?? "", id, origin, request.headers.get("cookie") ?? "");
    if (!ticket) return new Response(null, { status: 403 });
    return await upgradeWebSocket(socket => {
      socket.on("error", () => socket.close());
      waitUntil(servePngFrames(socket, () => runnerFrame(ticket.userId, id, ticket.sessionId)));
    }, { maxPayload: 1024 });
  } catch { return new Response(null, { status: 503 }); }
}
