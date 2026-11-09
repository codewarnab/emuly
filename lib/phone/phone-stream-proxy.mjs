import { asyncDb } from "../data/async-db.ts";
import { takeSharedStreamTicket } from "./shared-stream-ticket.ts";
import ws from "next/dist/compiled/ws/index.js";
import { takeStreamTicket } from "./phone-stream-ticket.ts";

export function attachPhoneStreams(server, nextUpgrade) {
  const sockets = new ws.WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });
  server.on("upgrade", async (req, socket, head) => {
    let url, phoneId;
    try { url = new URL(req.url ?? "/", "http://localhost"); phoneId = decodeURIComponent(url.pathname.split("/")[3] ?? ""); }
    catch { return socket.destroy(); }
    const match = /^\/app\/phones\/([^/]+)\/(stream|frames)$/.exec(url.pathname);
    if (!match) return nextUpgrade(req, socket, head);
    let ticket = takeStreamTicket(url.searchParams.get("ticket") ?? "", phoneId,
      req.headers.origin ?? "", req.headers.cookie ?? "");
    if (!ticket) {
      try {
        const shared = await takeSharedStreamTicket(asyncDb(), url.searchParams.get("ticket") ?? "", phoneId, req.headers.origin ?? "", req.headers.cookie ?? "");
        if (shared && match[2] === "frames") {
          const { servePngFrames } = await import("./png-stream.ts");
          const { runnerFrame } = await import("./runner-frame.ts");
          return sockets.handleUpgrade(req, socket, head, browser => {
            browser.on("error", () => browser.close());
            void servePngFrames(browser, () => runnerFrame(shared.userId, phoneId, shared.sessionId));
          });
        }
        if (shared) ticket = { open: async () => (await import("./phone-runner.ts")).runnerStream(shared.userId, phoneId, shared.sessionId) };
      } catch (error) { console.warn(`[stream] ${phoneId}: shared ticket failed:`, error?.message ?? error); return socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
    }
    if (!ticket) { console.warn(`[stream] ${phoneId}: ticket rejected`); return socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
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
      upstream.on("error", error => { console.warn(`[stream] ${phoneId}: runner socket error:`, error.message); if (!opened) lease.failed?.(); socket.destroy(); close(); });
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
            if (!binary && data.length < 1024) {
              try { const summary = JSON.parse(data.toString()); if (summary.type === "pong" && summary.inputAccepted === true) lease.acceptedInput?.(); }
              catch { /* Invalid upstream messages are never diagnostics. */ }
            }
            if (browser.bufferedAmount > 4 * 1024 * 1024) return close();
            browser.send(data, { binary });
          });
        });
      });
    } catch (error) { console.warn(`[stream] ${phoneId}: runner open failed:`, error?.message ?? error); lease?.release(); socket.destroy(); }
    finally { clearTimeout(timeout); }
  });
}
