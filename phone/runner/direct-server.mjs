// The direct (public) port. It serves `GET /stream` as a WebSocket, `PUT /adb` (a large file
// for one adb command) and `PUT /app-installs/<id>/content` (one browser APK chunk, with CORS),
// each with its own kind of signed ticket.
// Every other request gets 404. With no valid phone key it does not listen (fail closed).
import { PORTS, isCodespaceName } from "./contracts.mjs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { CHUNK_TICKET_TTL_MS, createNonceStore, createRateLimiter, TICKET_TTL_MS, UPLOAD_TICKET_TTL_MS, verifyChunkTicket, verifyTicket, verifyUploadTicket } from "./direct-ticket.mjs";
import { APK_CHUNK_BYTES } from "./contracts.mjs";

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
    return KEY.test(key) && isCodespaceName(codespace) ? { key, codespace } : undefined;
  } catch { return undefined; }
}

/**
 * attach(client, quality, { audio }) connects an accepted socket to the shared video stream.
 * upload(req, ticketPayload) runs one adb file command with the request body as the files and returns JSON.
 * chunk(operationId, bytes, offset, digest) stores one APK chunk of an Apps installation and returns its JSON view.
 * Returns { start, stop, revoke, clients, listening }.
 */
export function createDirectServer({ ws, keyFile, port = /** @type {number} */ (PORTS.DIRECT), host = "127.0.0.1", attach, upload = /** @type {((req: any, ticket: any) => Promise<unknown>) | undefined} */ (undefined),
  chunk = /** @type {((id: string, bytes: Buffer, offset: number, digest: string) => Promise<unknown>) | undefined} */ (undefined),
  maxViewers = 8, upgradesPerMinute = 20, uploadsPerMinute = 10, chunksPerMinute = 300, keyPollMs = 5_000, qualities = /** @type {Record<string, unknown>} */ ({ auto: true }), log = () => {} }) {
  const nonces = createNonceStore();
  const allow = createRateLimiter({ max: upgradesPerMinute, windowMs: 60_000 });
  const allowUpload = createRateLimiter({ max: uploadsPerMinute, windowMs: 60_000 });
  const allowChunk = createRateLimiter({ max: chunksPerMinute, windowMs: 60_000 });
  const sockets = new ws.WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });
  const clients = new Map(); // client -> payload
  const revoked = { all: 0, users: new Map() };
  let key, codespace, server, poll, stopped = false;

  const notFound = (_req, res) => { res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" }); res.end("not found"); };

  function refuse(socket, status = 404) {
    socket.end(`HTTP/1.1 ${status} ${status === 429 ? "Too Many Requests" : status === 503 ? "Service Unavailable" : "Not Found"}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    socket.destroy();
  }

  function isRevoked(payload, ttl = TICKET_TTL_MS) {
    const issued = payload.exp - ttl;
    return issued <= revoked.all || issued <= (revoked.users.get(payload.userId) ?? 0);
  }

  /**
   * `PUT /app-installs/<id>/content` with `Authorization: Emuly-Chunk <ticket>`, from the browser.
   * The preflight carries no ticket, so it only names what the real request may send.
   * The real request gets CORS headers only when the ticket's origin is the request's origin.
   */
  async function handleChunk(req, res, operationId) {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    const cors = origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...cors, "access-control-allow-methods": "PUT",
        "access-control-allow-headers": "authorization, content-type, x-upload-offset, x-chunk-sha256",
        "access-control-max-age": "600", "cache-control": "no-store" });
      return res.end();
    }
    let allowed = false;
    const send = (status, value, close = false) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(allowed ? cors : {}), ...(close ? { connection: "close" } : {}) });
      res.end(JSON.stringify(value));
      if (close) res.once("finish", () => req.destroy());
    };
    if (!allowChunk(clientAddress(req))) return send(429, { error: "rate_limited", message: "Too many upload chunks. Wait one minute." }, true);
    const match = /^Emuly-Chunk ([A-Za-z0-9_.-]+)$/.exec(req.headers.authorization ?? "");
    const result = verifyChunkTicket(key, match?.[1], { codespace, operationId, origin });
    if (!result.ok || isRevoked(result.payload, CHUNK_TICKET_TTL_MS)) {
      log(`direct: chunk refused (${result.ok ? "revoked" : result.reason})`);
      return send(401, { error: "invalid_ticket", message: "The upload ticket is missing, expired, or for another installation." }, true);
    }
    allowed = true;
    const offsetText = String(req.headers["x-upload-offset"] ?? "");
    const digest = String(req.headers["x-chunk-sha256"] ?? "");
    if (req.headers["content-type"] !== "application/octet-stream" || !/^\d+$/.test(offsetText) || !/^[a-f0-9]{64}$/.test(digest))
      return send(400, { error: "invalid_input", message: "Invalid upload offset, digest or content type." }, true);
    if (Number(req.headers["content-length"]) > APK_CHUNK_BYTES) return send(413, { error: "upload_too_large", message: "Upload chunk too large." }, true);
    req.setTimeout(30_000, () => req.destroy());
    const parts = []; let size = 0;
    try {
      for await (const part of req) {
        size += part.length;
        if (size > APK_CHUNK_BYTES) return send(413, { error: "upload_too_large", message: "Upload chunk too large." }, true);
        parts.push(part);
      }
    } catch { return; }
    try { send(200, await chunk(operationId, Buffer.concat(parts), Number(offsetText), digest)); }
    catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      send(status, { error: error?.code ?? (status < 500 ? "invalid_input" : "upload_failed"),
        message: error?.status ? error.message : "The chunk could not be stored. Retry." });
    }
  }

  /** `PUT /adb` with `Authorization: Emuly-Ticket <ticket>`. The ticket, not the request, gives the args. */
  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunkPath = /^\/app-installs\/([0-9a-f-]{36})\/content$/.exec(url.pathname);
    if (chunkPath && key && chunk && (req.method === "PUT" || req.method === "OPTIONS")) return handleChunk(req, res, chunkPath[1]);
    if (req.method !== "PUT" || url.pathname !== "/adb" || !key || !upload) return notFound(req, res);
    const send = (status, value, close = false) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(close ? { connection: "close" } : {}) });
      res.end(JSON.stringify(value));
      // A refused body is not read: close the socket instead of taking up to 1 GiB.
      if (close) res.once("finish", () => req.destroy());
    };
    if (!allowUpload(clientAddress(req))) return send(429, { error: "rate_limited", message: "Too many uploads. Wait one minute." }, true);
    const match = /^Emuly-Ticket ([A-Za-z0-9_.-]+)$/.exec(req.headers.authorization ?? "");
    const result = verifyUploadTicket(key, match?.[1], { codespace, nonces });
    if (!result.ok || isRevoked(result.payload, UPLOAD_TICKET_TTL_MS)) {
      log(`direct: upload refused (${result.ok ? "revoked" : result.reason})`);
      return send(401, { error: "invalid_ticket",
        message: "The upload ticket is missing, expired, already used, or for another phone. Ask Emuly for a new ticket." }, true);
    }
    try { send(200, await upload(req, result.payload)); }
    catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      send(status, { error: status === 413 ? "upload_too_large" : status === 409 ? "phone_conflict" : status < 500 ? "invalid_input" : "upload_failed",
        message: error?.status ? error.message : "The upload failed. Retry with a new ticket." }, !req.complete);
    }
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
      server = createServer((req, res) => void handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }));
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
