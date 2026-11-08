import { upgradeWebSocket, type WebSocket, type WebSocketData } from "@vercel/functions";
import { WebSocket as Upstream } from "ws";
import { asyncDb } from "../../../../../../lib/data/async-db";
import { takeSharedStreamTicket } from "../../../../../../lib/phone/shared-stream-ticket";
import { runnerStream } from "../../../../../../lib/phone/phone-runner";

export const maxDuration = 300;
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const origin = request.headers.get("origin") ?? "";
  if (origin !== url.origin) return new Response(null, { status: 403 });
  const ticket = await takeSharedStreamTicket(asyncDb(), url.searchParams.get("ticket") ?? "", id, origin, request.headers.get("cookie") ?? "");
  if (!ticket) return new Response(null, { status: 403 });
  let lease: Awaited<ReturnType<typeof runnerStream>> | undefined;
  try {
    lease = await runnerStream(ticket.userId, id, ticket.sessionId);
    const quality = ["auto", "sharp", "saver"].includes(url.searchParams.get("quality") ?? "") ? url.searchParams.get("quality") : "auto";
    const upstream = new Upstream(`${lease.url}?quality=${quality}`, { headers: lease.headers, followRedirects: false,
      handshakeTimeout: 15_000, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => { upstream.once("open", resolve); upstream.once("error", reject); });
    let browser: WebSocket | undefined;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      upstream.terminate();
      browser?.close(1012, "Reconnect");
      lease!.signal.removeEventListener("abort", close);
      lease!.release();
    };
    const deadline = setTimeout(close, 280_000);
    lease.signal.addEventListener("abort", close, { once: true });
    upstream.on("error", close);
    upstream.on("close", close);
    try {
      return await upgradeWebSocket(socket => {
        browser = socket;
        if (closed || lease!.signal.aborted) { close(); socket.close(); return; }
        socket.on("error", close);
        socket.on("close", close);
        socket.on("message", (data: WebSocketData, binary: boolean) => {
          if (binary || (Array.isArray(data) ? data.reduce((n, part) => n + part.byteLength, 0) : data.byteLength) > 16_384 || upstream.bufferedAmount > 65_536) return close();
          upstream.send(data, { binary: false });
        });
        upstream.on("message", (data, binary) => {
          if (socket.bufferedAmount > 4 * 1024 * 1024) return close();
          socket.send(data, { binary });
        });
      }, { maxPayload: 16_384 });
    } catch { close(); return new Response(null, { status: 503 }); }
  } catch { lease?.release(); return new Response(null, { status: 503 }); }
}
