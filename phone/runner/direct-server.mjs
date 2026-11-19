// The direct (public) port. It serves only `GET /stream` as a WebSocket with a signed ticket.
// Every other request gets 404. With no valid phone key it does not listen (fail closed).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createNonceStore, createRateLimiter, TICKET_TTL_MS, verifyTicket } from "./direct-ticket.mjs";

const KEY = /^[0-9a-f]{64}$/;

/** The client address. GitHub's port forward appends the caller to X-Forwarded-For, so use the last entry. */
export function clientAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const last = typeof forwarded === "string" ? forwarded.split(",").pop()?.trim() : "";
  return last || req.socket.remoteAddress || "unknown";
}

/** The key file has two lines: the 64-hex phone key and the codespace name. */
export async function readPhoneKey(file) {
  try {
    const [key, codespace] = (await readFile(file, "utf8")).trim().split(/\s+/);
    return KEY.test(key) && /^[\w-]{1,100}$/.test(codespace ?? "") ? { key, codespace } : undefined;
  } catch { return undefined; }
}

/**
 * attach(client, quality, { audio }) connects an accepted socket to the shared video stream.
 * Returns { start, stop, revoke, clients, listening }.
 */
export function createDirectServer({ ws, keyFile, port = 8791, host = "127.0.0.1", attach,
  maxViewers = 8, upgradesPerMinute = 20, keyPollMs = 5_000, qualities = /** @type {Record<string, unknown>} */ ({ auto: true }), log = () => {} }) {
  const nonces = createNonceStore();
  const allow = createRateLimiter({ max: upgradesPerMinute, windowMs: 60_000 });
  const sockets = new ws.WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });
  const clients = new Map(); // client -> payload
  const revoked = { all: 0, users: new Map() };
  let key, codespace, server, poll, stopped = false;

  const notFound = (_req, res) => { res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" }); res.end("not found"); };

  function refuse(socket, status = 404) {
    socket.end(`HTTP/1.1 ${status} ${status === 429 ? "Too Many Requests" : status === 503 ? "Service Unavailable" : "Not Found"}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    socket.destroy();
  }

  function isRevoked(payload) {
    const issued = payload.exp - TICKET_TTL_MS;
    return issued <= revoked.all || issued <= (revoked.users.get(payload.userId) ?? 0);
  }

  function upgrade(req, socket, head) {
    socket.on("error", () => {});
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" || url.pathname !== "/stream" || !key) return refuse(socket);
    if (!allow(clientAddress(req))) return refuse(socket, 429);
    const result = verifyTicket(key, url.searchParams.get("ticket"), { codespace, origin: req.headers.origin, nonces });
    if (!result.ok || isRevoked(result.payload)) { log(`direct: refused (${result.ok ? "revoked" : result.reason})`); return refuse(socket); }
    if (clients.size >= maxViewers) return refuse(socket, 503);
    const payload = result.payload;
    sockets.handleUpgrade(req, socket, head, client => {
      clients.set(client, payload);
      client.once("close", () => clients.delete(client));
      const quality = Object.hasOwn(qualities, payload.quality) ? payload.quality : "auto";
      attach(client, quality, { audio: url.searchParams.get("audio") === "1" });
    });
  }

  async function check() {
    const next = await readPhoneKey(keyFile);
    if (stopped) return;
    key = next?.key;
    codespace = next?.codespace;
    if (key && !server) {
      server = createServer(notFound);
      server.on("upgrade", upgrade);
      server.on("clientError", (_error, socket) => socket.destroy());
      await new Promise((resolve, reject) => server.once("error", reject).listen(port, host, resolve));
      log(`direct: listening on ${host}:${port}`);
    } else if (!key && server) {
      close();
    }
  }

  function close() {
    for (const client of clients.keys()) client.terminate();
    clients.clear();
    server?.close();
    server = undefined;
  }

  return {
    async start() {
      await check().catch(error => log(`direct: ${error.message}`));
      poll = setInterval(() => void check().catch(error => log(`direct: ${error.message}`)), keyPollMs);
      poll.unref();
    },
    stop() { stopped = true; clearInterval(poll); close(); },
    /** Closes direct sockets and refuses older tickets. No userId means every user. */
    revoke(userId, now = Date.now()) {
      if (userId === undefined) revoked.all = now;
      else revoked.users.set(userId, now);
      let closed = 0;
      for (const [client, payload] of clients) {
        if (userId === undefined || payload.userId === userId) { client.close(4001, "revoked"); setTimeout(() => client.terminate(), 500).unref(); closed++; }
      }
      return closed;
    },
    clients,
    get listening() { return Boolean(server?.listening); },
    get port() { return server?.address()?.port; },
  };
}
