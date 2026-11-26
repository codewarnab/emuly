// @ts-check
// Egress gateway: the emulator starts with `-http-proxy http://127.0.0.1:8792`, so every TCP
// connection of the phone comes here (docs/phone-proxy-plan.md). Port 80 comes as a plain proxy
// request (`GET http://host/...`); all other ports come as CONNECT.
// - mode "direct": connect out from the codespace. Private and link-local targets are refused.
// - mode "laptop": send a CONNECT to 127.0.0.1:<link port>, where `emuly proxy` on the laptop
//   listens through its link. If the link is down, the connection fails. It never goes direct.
// 127.0.0.1 targets are the phone's 10.0.2.2 address. They stay on the codespace in both modes.
// No runtime dependencies, Node 16 or later.
import { connect, createServer, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { request } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { lanBlocked } from "./ip-policy.mjs";

export const EGRESS_PORT = 8792;
export const EGRESS_MODES = ["direct", "laptop"];
export const EGRESS_FILE = "/workspaces/.emuly/egress.json";
/** Codespace ports that a phone app must not reach through 10.0.2.2: runner, adb, emulator, direct stream, this gateway. */
export const LOOPBACK_BLOCKED = new Set([4310, 5037, 5554, 5555, 8790, 8791, EGRESS_PORT]);
const HEAD_MAX = 16 * 1024;
const HEAD_MS = 10_000;
const CONNECT_MS = 10_000;
/**
 * An unlocked laptop proxy with no laptop for this long goes back to direct. Without it, a laptop that
 * sleeps or a CLI that is killed (no Ctrl-C) leaves the phone offline until `emuly proxy off`.
 * It is longer than a normal reconnect (~10 s). A locked proxy never falls back: that is what --lock means.
 */
export const ORPHAN_MS = 120_000;
const WATCH_MS = 15_000;

export class EgressError extends Error { status = 400; }

/**
 * True when direct mode must refuse this address (ip-policy.mjs `lanBlocked`). The caller
 * handles 127.0.0.1.
 * @param {string} ip @returns {boolean}
 */
export const blockedAddress = ip => lanBlocked(ip);

/** The phone's own slirp network (10.0.2.0/24): DNS 10.0.2.3, and Private DNS on 10.0.2.3:853. */
export const slirpAddress = (/** @type {string} */ host) => /^10\.0\.2\.\d{1,3}$/.test(host);

/**
 * Parses the request head from the emulator.
 * @param {Buffer} buffer bytes so far
 * @returns {undefined | { kind: "connect" | "http", host: string, port: number, head: Buffer, rest: Buffer }}
 *   undefined while the head is not complete. `head` is what to send upstream for "http" (path form, Connection: close).
 */
export function parseHead(buffer) {
  const end = buffer.indexOf("\r\n\r\n");
  if (end < 0) {
    if (buffer.length > HEAD_MAX) throw new EgressError("The request head is too large.");
    return undefined;
  }
  const text = buffer.subarray(0, end).toString("latin1");
  const rest = buffer.subarray(end + 4);
  const [line, ...headers] = text.split("\r\n");
  const connectLine = /^CONNECT (\[[0-9a-fA-F:.]+\]|[^\s:]+):(\d{1,5}) HTTP\/1\.[01]$/.exec(line);
  if (connectLine) return { kind: "connect", ...target(connectLine[1], connectLine[2]), head: Buffer.alloc(0), rest };
  const httpLine = /^([A-Z]{3,10}) http:\/\/(\[[0-9a-fA-F:.]+\]|[^\s/:?#]+)(?::(\d{1,5}))?(\S*) (HTTP\/1\.[01])$/.exec(line);
  if (!httpLine) throw new EgressError("The gateway takes CONNECT or an absolute http:// request.");
  const [, method, host, port, rawPath, version] = httpLine;
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  // One request for each upstream connection: the emulator sends later requests in the same
  // absolute form, and a body length is not parsed here. Connection: close keeps that safe.
  const kept = headers.filter(header => !/^(proxy-connection|connection|keep-alive|proxy-authorization)\s*:/i.test(header));
  const head = Buffer.from([`${method} ${path} ${version}`, ...kept, "Connection: close", "", ""].join("\r\n"), "latin1");
  return { kind: "http", ...target(host, port ?? "80"), head, rest };
}

/** @param {string} rawHost @param {string} rawPort */
function target(rawHost, rawPort) {
  const host = rawHost.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new EgressError("Bad port.");
  if (!/^[a-z0-9.:_-]{1,253}$/.test(host)) throw new EgressError("Bad host.");
  return { host, port };
}

/**
 * Checks a POST /egress body. Laptop mode needs the codespace port of the laptop's link.
 * @param {any} body
 */
export function egressSetting(body) {
  const mode = body?.mode;
  if (!EGRESS_MODES.includes(mode)) throw new EgressError(`mode is ${EGRESS_MODES.join(" or ")}.`);
  if (mode === "direct") return { mode, port: undefined, lock: false };
  const port = body?.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || LOOPBACK_BLOCKED.has(port)) {
    throw new EgressError("port is the codespace port of the laptop link, 1024-65535.");
  }
  return { mode, port, lock: body?.lock === true };
}

/**
 * @param {{ file?: string, listenPort?: number, lookup?: typeof dnsLookup, upstreamHost?: string,
 *   log?: (line: string) => void, orphanMs?: number, watchMs?: number }} [options]
 */
export function createEgress({ file = EGRESS_FILE, listenPort = EGRESS_PORT, lookup = dnsLookup, upstreamHost = "127.0.0.1",
  log = () => {}, orphanMs = ORPHAN_MS, watchMs = WATCH_MS } = {}) {
  /** @type {{ mode: string, port?: number, lock: boolean, since: string }} */
  let setting = { mode: "direct", port: undefined, lock: false, since: new Date().toISOString() };
  const counters = { connections: 0, active: 0, refused: 0, failed: 0, bytes_up: 0, bytes_down: 0, upstream_ms_last: 0, upstream_ms_avg: 0 };
  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set();
  /** @type {import("node:net").Server | undefined} */
  let server;
  /** When the laptop link was last seen open (or the mode last changed). */
  let seenAt = Date.now();
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let watch;

  /** Falls back to direct when an unlocked laptop proxy has had no laptop for orphanMs. */
  async function watchLaptop() {
    if (setting.mode !== "laptop" || setting.lock) { seenAt = Date.now(); return; }
    if (await upstreamOpen()) { seenAt = Date.now(); return; }
    if (Date.now() - seenAt < orphanMs) return;
    log("egress: laptop proxy gone, back to direct");
    await set({ mode: "direct" }).catch(() => {});
  }

  async function load() {
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      const checked = egressSetting(saved);
      setting = { ...checked, since: typeof saved.since === "string" ? saved.since : new Date().toISOString() };
    } catch { /* No file or a bad file: direct. */ }
    return status();
  }

  /** @param {any} body */
  async function set(body) {
    const checked = egressSetting(body);
    const changed = checked.mode !== setting.mode || checked.port !== setting.port;
    setting = { ...checked, since: changed ? new Date().toISOString() : setting.since };
    seenAt = Date.now();
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(setting));
    await rename(temporary, file);
    // A mode change ends the open connections, so no app keeps a path that the user turned off.
    if (changed) for (const socket of sockets) socket.destroy();
    return status();
  }

  /** True when something listens on the laptop link port. */
  function upstreamOpen() {
    if (setting.mode !== "laptop" || !setting.port) return Promise.resolve(false);
    return new Promise(resolve => {
      const socket = connect({ host: upstreamHost, port: /** @type {number} */ (setting.port) });
      const done = (/** @type {boolean} */ open) => { socket.destroy(); resolve(open); };
      socket.setTimeout(2_000, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  }

  function status() {
    return { mode: setting.mode, port: setting.port ?? null, lock: setting.lock, since: setting.since, listening: Boolean(server?.listening),
      counters: { ...counters } };
  }

  /** @param {number} ms */
  function timed(ms) {
    counters.upstream_ms_last = ms;
    counters.upstream_ms_avg = counters.upstream_ms_avg ? Math.round(counters.upstream_ms_avg * 0.9 + ms * 0.1) : ms;
  }

  /**
   * Opens the upstream socket for one target, or throws an EgressError (refused) or a socket error.
   * @param {string} host @param {number} port
   * @returns {Promise<import("node:net").Socket>}
   */
  async function open(host, port) {
    const start = Date.now();
    // 10.0.2.2:X arrives as 127.0.0.1:X. It stays on the codespace in every mode, like before.
    if (host === "127.0.0.1") {
      if (LOOPBACK_BLOCKED.has(port)) throw new EgressError("Emuly uses this codespace port.");
      const socket = await dial("127.0.0.1", port);
      timed(Date.now() - start);
      return socket;
    }
    if (slirpAddress(host)) throw new EgressError("The phone's own network does not go through the gateway.");
    if (setting.mode === "laptop") {
      const socket = await dial(upstreamHost, /** @type {number} */ (setting.port));
      const name = isIP(host) === 6 ? `[${host}]` : host;
      socket.write(`CONNECT ${name}:${port} HTTP/1.1\r\nHost: ${name}:${port}\r\n\r\n`);
      const reply = await readHead(socket);
      if (!/^HTTP\/1\.[01] 200/.test(reply.line)) { socket.destroy(); throw new EgressError(`The laptop refused: ${reply.line.slice(0, 80)}`); }
      if (reply.rest.length) socket.unshift(reply.rest);
      timed(Date.now() - start);
      return socket;
    }
    // Every address of the name must be public, so a name cannot point the phone at the codespace.
    // IPv4 goes first: the codespace has no IPv6 route.
    /** @type {string[]} */
    const addresses = isIP(host) ? [host] : await new Promise((resolve, reject) => {
      lookup(host, { all: true }, (error, list) => error || !list?.length ? reject(new EgressError("DNS lookup failed."))
        : resolve(list.sort((a, b) => a.family - b.family).map(entry => entry.address)));
    });
    if (addresses.some(blockedAddress)) throw new EgressError("Direct mode does not reach private addresses.");
    const socket = await dial(addresses[0], port);
    timed(Date.now() - start);
    return socket;
  }

  /** @param {string} host @param {number} port @returns {Promise<import("node:net").Socket>} */
  function dial(host, port) {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port, allowHalfOpen: true });
      socket.setNoDelay(true);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("connect timeout")); }, CONNECT_MS);
      socket.once("connect", () => { clearTimeout(timer); socket.removeAllListeners("error"); resolve(socket); });
      socket.once("error", error => { clearTimeout(timer); reject(error); });
    });
  }

  /** Reads one HTTP response head from a socket. @param {import("node:net").Socket} socket */
  function readHead(socket) {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const timer = setTimeout(() => finish(new Error("no reply")), CONNECT_MS);
      const onData = (/** @type {Buffer} */ chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf("\r\n\r\n");
        if (end >= 0) finish(undefined, { line: buffer.subarray(0, buffer.indexOf("\r\n")).toString("latin1"), rest: buffer.subarray(end + 4) });
        else if (buffer.length > HEAD_MAX) finish(new Error("reply too large"));
      };
      const onEnd = () => finish(new EgressError("The laptop closed the connection."));
      /** @param {Error} [error] @param {any} [value] */
      function finish(error, value) {
        clearTimeout(timer);
        socket.off("data", onData); socket.off("end", onEnd); socket.off("error", onEnd);
        if (error) { socket.destroy(); reject(error); } else { socket.pause(); resolve(value); }
      }
      socket.on("data", onData); socket.once("end", onEnd); socket.once("error", onEnd);
    });
  }

  /** @param {import("node:net").Socket} client */
  function handle(client) {
    counters.connections++; counters.active++;
    sockets.add(client);
    client.setNoDelay(true);
    client.once("close", () => { counters.active--; sockets.delete(client); });
    client.on("error", () => client.destroy());
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => client.destroy(), HEAD_MS);
    const onData = async (/** @type {Buffer} */ chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let request;
      try { request = parseHead(buffer); }
      catch { clearTimeout(timer); client.off("data", onData); counters.refused++; client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
      if (!request) return;
      clearTimeout(timer);
      client.off("data", onData);
      client.pause();
      let upstream;
      try { upstream = await open(request.host, request.port); }
      catch (error) {
        if (error instanceof EgressError) counters.refused++; else counters.failed++;
        // Plain HTTP gets a 403 or 502 that a browser can show. CONNECT gets a closed socket (Phase 0 check 2).
        if (request.kind === "http") client.end(`HTTP/1.1 ${error instanceof EgressError ? "403 Forbidden" : "502 Bad Gateway"}\r\nConnection: close\r\n\r\n`);
        else client.destroy();
        return;
      }
      if (client.destroyed) { upstream.destroy(); return; }
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream));
      upstream.on("error", () => { upstream.destroy(); client.destroy(); });
      client.on("error", () => upstream.destroy());
      client.once("close", () => upstream.destroy());
      upstream.once("close", () => client.destroy());
      if (request.kind === "connect") client.write("HTTP/1.1 200 Connection established\r\n\r\n");
      else upstream.write(request.head);
      if (request.rest.length) { counters.bytes_up += request.rest.length; upstream.write(request.rest); }
      client.on("data", data => { counters.bytes_up += data.length; });
      upstream.on("data", data => { counters.bytes_down += data.length; });
      // CONNECT passes the half-close on (a download after the request needs it, Phase 0). Plain HTTP
      // is one request with Connection: close, and some servers drop a request on a half-close, so
      // the upstream end comes from the server.
      client.pipe(upstream, { end: request.kind === "connect" }); upstream.pipe(client);
      client.resume(); upstream.resume();
    };
    client.on("data", onData);
  }

  /** Starts the gateway on 127.0.0.1 only. */
  function listen() {
    return new Promise((resolve, reject) => {
      server = createServer({ allowHalfOpen: true }, handle);
      server.once("error", reject);
      server.listen(listenPort, "127.0.0.1", () => { log(`egress gateway on 127.0.0.1:${listenPort}`); resolve(status()); });
      watch = setInterval(() => void watchLaptop(), watchMs);
      watch.unref?.();
    });
  }

  /** The bound port (listenPort 0 picks one, for tests). */
  const boundPort = () => { const address = server?.address(); return typeof address === "object" && address ? address.port : listenPort; };

  function close() {
    clearInterval(watch);
    for (const socket of sockets) socket.destroy();
    return new Promise(resolve => server ? server.close(() => resolve(undefined)) : resolve(undefined));
  }

  /**
   * Gets the exit IP through the gateway itself, so the answer matches what the phone uses.
   * The IP goes back to the caller only. It is never logged.
   */
  function check({ host = "api.ipify.org", gatewayPort = boundPort() } = {}) {
    const start = Date.now();
    return new Promise(resolve => {
      const req = request({ host: "127.0.0.1", port: gatewayPort, path: `http://${host}/?format=json`, headers: { host }, timeout: 10_000 }, res => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { if (body.length < 4096) body += chunk; });
        res.on("end", () => {
          let ip;
          try { ip = JSON.parse(body).ip; } catch {}
          resolve(res.statusCode === 200 && typeof ip === "string" && isIP(ip)
            ? { ok: true, mode: setting.mode, exit_ip: ip, ms: Date.now() - start }
            : { ok: false, mode: setting.mode, error: res.statusCode === 403 ? "refused" : "bad_reply", ms: Date.now() - start });
        });
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", error => resolve({ ok: false, mode: setting.mode, error: error.message === "timeout" ? "timeout" : "unreachable", ms: Date.now() - start }));
      req.end();
    });
  }

  return { load, set, status, upstreamOpen, listen, close, check, port: boundPort, setting: () => ({ ...setting }) };
}
