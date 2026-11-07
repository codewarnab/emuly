import ws from "next/dist/compiled/ws/index.js";
import { takeStreamTicket } from "./phone-stream-ticket.ts";

export function attachPhoneStreams(server, nextUpgrade) {
  const sockets = new ws.WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });
  server.on("upgrade", async (req, socket, head) => {
    let url, phoneId;
    try { url = new URL(req.url ?? "/", "http://localhost"); phoneId = decodeURIComponent(url.pathname.split("/")[3] ?? ""); }
    catch { return socket.destroy(); }
    const match = /^\/app\/phones\/([^/]+)\/stream$/.exec(url.pathname);
    if (!match) return nextUpgrade(req, socket, head);
    const ticket = takeStreamTicket(url.searchParams.get("ticket") ?? "", phoneId,
      req.headers.origin ?? "", req.headers.cookie ?? "");
    if (!ticket) return socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    let lease;
    const timeout = setTimeout(() => socket.destroy(), 90_000);
    try {
      lease = await ticket.open();
      if (socket.destroyed || lease.signal.aborted) { lease.release(); return socket.destroy(); }
      const quality = ["auto", "sharp", "saver"].includes(url.searchParams.get("quality")) ? url.searchParams.get("quality") : "auto";
      const upstream = new ws(lease.url + `?quality=${quality}`, { headers: lease.headers, followRedirects: false,
        handshakeTimeout: 15_000, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
      let client, opened = false;
      const close = () => { upstream.terminate(); client?.terminate(); lease.release(); };
      const abort = () => close();
      lease.signal.addEventListener("abort", abort, { once: true });
      upstream.on("error", () => { if (!opened) lease.failed?.(); socket.destroy(); close(); });
      socket.once("close", close);
      upstream.once("close", () => { lease.signal.removeEventListener("abort", abort); socket.destroy(); close(); });
      upstream.once("open", () => {
        opened = true;
        if (socket.destroyed || lease.signal.aborted) return close();
        sockets.handleUpgrade(req, socket, head, browser => {
          client = browser;
          browser.on("error", close);
          browser.on("close", close);
          browser.on("message", (data, binary) => {
            if (binary || upstream.bufferedAmount > 65_536) return close();
            upstream.send(data, { binary: false });
          });
          upstream.on("message", (data, binary) => {
            if (browser.bufferedAmount > 4 * 1024 * 1024) return close();
            browser.send(data, { binary });
          });
        });
      });
    } catch { lease?.release(); socket.destroy(); }
    finally { clearTimeout(timeout); }
  });
}
