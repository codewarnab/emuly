// @ts-check
// DNS for the phone. The emulator starts with `-dns-server 127.0.0.77`, and this process answers
// there (127.0.0.53 belongs to systemd-resolved). boot.sh runs it with a copy of node that has
// cap_net_bind_service, because port 53 is below 1024 (docs/phone-proxy-plan.md, Phase 0 check 5).
// - mode "direct": each query goes to the codespace resolver over UDP, as before.
// - mode "laptop": each query goes as DNS over TCP, inside a CONNECT through the laptop link, so
//   the lookup leaves from the laptop (or its upstream proxy). Link down: SERVFAIL, never direct.
// It reads the mode from the same file as the gateway (egress.mjs). Node 16 or later.
import { createSocket } from "node:dgram";
import { connect } from "node:net";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DNS_ADDRESS = "127.0.0.77";
const QUERY_MS = 5_000;

/** A SERVFAIL answer for a query: same id and question, QR set, RCODE 2. @param {Buffer} query */
export function servfail(query) {
  if (query.length < 12) return undefined;
  const reply = Buffer.from(query);
  reply[2] = 0x80 | (query[2] & 0x79); // QR, keep opcode and RD
  reply[3] = 0x80 | 0x02; // RA, SERVFAIL
  reply.writeUInt16BE(0, 6); reply.writeUInt16BE(0, 8); reply.writeUInt16BE(0, 10);
  return reply;
}

/** DNS over TCP puts a 2-byte length before each message. @param {Buffer} message */
export const tcpFrame = message => Buffer.concat([Buffer.from([message.length >> 8, message.length & 0xff]), message]);

/**
 * Sends one query through the laptop link and resolves the answer, or rejects.
 * @param {Buffer} query @param {{ host: string, port: number, resolver: string }} via
 */
export function queryOverLink(query, { host, port, resolver }) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let buffer = Buffer.alloc(0), connected = false;
    const timer = setTimeout(() => done(new Error("timeout")), QUERY_MS);
    /** @param {Error} [error] @param {Buffer} [answer] */
    function done(error, answer) { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(answer); }
    socket.once("connect", () => socket.write(`CONNECT ${resolver} HTTP/1.1\r\nHost: ${resolver}\r\n\r\n`));
    socket.on("data", (/** @type {Buffer} */ chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!connected) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        if (!/^HTTP\/1\.[01] 200/.test(buffer.toString("latin1", 0, Math.min(end, 40)))) return done(new Error("refused"));
        connected = true;
        buffer = buffer.subarray(end + 4);
        socket.write(tcpFrame(query));
      }
      if (buffer.length >= 2 && buffer.length >= 2 + buffer.readUInt16BE(0)) done(undefined, buffer.subarray(2, 2 + buffer.readUInt16BE(0)));
    });
    socket.once("error", error => done(error));
    socket.once("end", () => done(new Error("closed")));
  });
}

/**
 * @param {{ file?: string, address?: string, port?: number, resolver?: { host: string, port: number },
 *   laptopResolver?: string, upstreamHost?: string }} [options]
 */
export function createDnsForwarder({ file = "/workspaces/.emuly/egress.json", address = DNS_ADDRESS, port = 53,
  resolver = { host: "127.0.0.53", port: 53 }, laptopResolver = "1.1.1.1:53", upstreamHost = "127.0.0.1" } = {}) {
  let cached = { mtime: -1, mode: "direct", port: 0 };
  function setting() {
    try {
      const { mtimeMs } = statSync(file);
      if (mtimeMs !== cached.mtime) {
        const saved = JSON.parse(readFileSync(file, "utf8"));
        cached = { mtime: mtimeMs, mode: saved.mode === "laptop" ? "laptop" : "direct", port: Number(saved.port) || 0 };
      }
    } catch { cached = { mtime: -1, mode: "direct", port: 0 }; }
    return cached;
  }

  const server = createSocket("udp4");
  const upstream = createSocket("udp4");
  /** Pending direct queries by upstream id. @type {Map<number, { id: number, address: string, port: number, timer: NodeJS.Timeout }>} */
  const pending = new Map();
  let nextId = 1;
  const counters = { queries: 0, laptop: 0, failed: 0 };

  upstream.on("message", answer => {
    if (answer.length < 12) return;
    const entry = pending.get(answer.readUInt16BE(0));
    if (!entry) return;
    pending.delete(answer.readUInt16BE(0));
    clearTimeout(entry.timer);
    const reply = Buffer.from(answer);
    reply.writeUInt16BE(entry.id, 0);
    server.send(reply, entry.port, entry.address);
  });

  server.on("message", (query, from) => {
    if (query.length < 12 || query.length > 4096) return;
    counters.queries++;
    const { mode, port: linkPort } = setting();
    if (mode === "laptop") {
      counters.laptop++;
      queryOverLink(query, { host: upstreamHost, port: linkPort, resolver: laptopResolver })
        .then(answer => server.send(/** @type {Buffer} */ (answer), from.port, from.address))
        .catch(() => { counters.failed++; const reply = servfail(query); if (reply) server.send(reply, from.port, from.address); });
      return;
    }
    // A fresh id for each forwarded query, so two clients with the same id do not mix.
    const id = nextId = (nextId % 0xffff) + 1;
    const forwarded = Buffer.from(query);
    forwarded.writeUInt16BE(id, 0);
    const timer = setTimeout(() => { pending.delete(id); counters.failed++; }, QUERY_MS);
    pending.get(id) && clearTimeout(/** @type {any} */ (pending.get(id)).timer);
    pending.set(id, { id: query.readUInt16BE(0), address: from.address, port: from.port, timer });
    upstream.send(forwarded, resolver.port, resolver.host);
  });

  return {
    counters: () => ({ ...counters }),
    /** @returns {Promise<number>} the bound port */
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      upstream.bind(0, "127.0.0.1", () => server.bind(port, address, () => resolve(server.address().port)));
    }),
    close: () => { for (const entry of pending.values()) clearTimeout(entry.timer); server.close(); upstream.close(); },
  };
}

// Run as a script by boot.sh: `node53 egress-dns.mjs`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const forwarder = createDnsForwarder();
  forwarder.listen().then(() => console.log(`emuly dns on ${DNS_ADDRESS}:53`), error => { console.error(`emuly dns: ${error.message}`); process.exit(1); });
}
