import { upgradeWebSocket, type WebSocket, type WebSocketData } from "@vercel/functions";
import { WebSocket as Upstream } from "ws";
import { asyncDb } from "../../../../../../lib/data/async-db";
import { crossOrigin } from "../../../../../../lib/auth/origin";
import { takeSharedStreamTicket } from "../../../../../../lib/phone/shared-stream-ticket";
import { runnerStream } from "../../../../../../lib/phone/phone-runner";

// TODO: move this relay off Vercel to a Cloudflare Worker. It is the video path for networks that
// block *.app.github.dev (for example Reliance Jio DNS), so it cannot go away. On Vercel each viewer
// holds a 2 GB function for up to 300 s and every video byte counts as Fast Origin Transfer.
// A Worker that passes the WebSocket through bills mostly per request (waiting is not CPU time).
// Check first: Cloudflare egress rules for WebSockets, latency from an Indian edge, and how the
// Worker checks the stream ticket without a Turso round trip (for example a signed ticket, as on port 8791).
export const maxDuration = 300;
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const origin = request.headers.get("origin") ?? "";
  if (crossOrigin(request, "session", { requireOrigin: true })) return new Response(null, { status: 403 });
  const ticket = await takeSharedStreamTicket(asyncDb(), url.searchParams.get("ticket") ?? "", id, origin, request.headers.get("cookie") ?? "");
  if (!ticket) return new Response(null, { status: 403 });
  let lease: Awaited<ReturnType<typeof runnerStream>> | undefined;
  let upstream: Upstream | undefined;
  try {
    lease = await runnerStream(ticket.userId, id, ticket.sessionId);
    const quality = ["auto", "sharp", "saver"].includes(url.searchParams.get("quality") ?? "") ? url.searchParams.get("quality") : "auto";
    const connection = upstream = new Upstream(`${lease.url}?quality=${quality}`, { headers: lease.headers, followRedirects: false,
      handshakeTimeout: 15_000, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => { connection.once("open", resolve); connection.once("error", reject); });
    let browser: WebSocket | undefined;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      connection.terminate();
      browser?.close(1012, "Reconnect");
      lease!.signal.removeEventListener("abort", close);
      lease!.release();
    };
    const deadline = setTimeout(close, 280_000);
    lease.signal.addEventListener("abort", close, { once: true });
    connection.on("error", close);
    connection.on("close", close);
    try {
      return await upgradeWebSocket(socket => {
        browser = socket;
        if (closed || lease!.signal.aborted) { close(); socket.close(); return; }
        socket.on("error", close);
        socket.on("close", close);
        socket.on("message", (data: WebSocketData, binary: boolean) => {
          if (binary || (Array.isArray(data) ? data.reduce((n, part) => n + part.byteLength, 0) : data.byteLength) > 16_384 || connection.bufferedAmount > 65_536) return close();
          connection.send(data, { binary: false });
        });
        connection.on("message", (data, binary) => {
          if (socket.bufferedAmount > 4 * 1024 * 1024) return close();
          socket.send(data, { binary });
        });
      }, { maxPayload: 16_384 });
    } catch { close(); return new Response(null, { status: 503 }); }
  } catch { upstream?.terminate(); lease?.release(); return new Response(null, { status: 503 }); }
}
