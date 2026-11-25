// @ts-check
// Links: one TCP port from the phone to a server that the user's laptop can reach.
// Shared by the dashboard and the standalone runner. No runtime dependencies.
// emuly.mjs keeps its own copy of the frame format, because it ships as one file.

/** Ports that the runner, adb or the emulator use in the codespace. A link must not take them. */
export const RESERVED_PORTS = new Set([4310, 5037, 5554, 5555, 8790, 8791, 8792]);
export const LINK_PORTS_MAX = 8;
export const LINKS_MAX = 16;
/** A relay frame carries at most this many payload bytes. */
export const RELAY_CHUNK = 64 * 1024;
/** Header (5 bytes) plus one chunk, with room to spare. */
export const RELAY_MAX_PAYLOAD = 128 * 1024;
export const LINK_ROUTES = ["ssh", "relay"];

/** Frame types. The runner sends OPEN; both ends send DATA and CLOSE. */
export const FRAME = { OPEN: 1, DATA: 2, CLOSE: 3 };

/** The runner sends `status` as the HTTP status. */
export class LinkError extends Error { status = 400; }

/** One port, 1024-65535, not reserved. Ports below 1024 need root on the phone and in the codespace. */
/** @param {unknown} value @returns {number} */
export function linkPort(value) {
  const port = typeof value === "string" && /^\d{1,5}$/.test(value) ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new LinkError("A port is a whole number from 1024 to 65535.");
  if (port < 1024) throw new LinkError(`Port ${port} is below 1024. Run the server on port 1024 or higher.`);
  if (RESERVED_PORTS.has(port)) throw new LinkError(`Port ${port} is used by Emuly in the codespace. Use another port.`);
  return port;
}

/** A list of 1-8 different ports. */
/** @param {unknown} value @returns {number[]} */
export function linkPorts(value) {
  if (!Array.isArray(value) || !value.length) throw new LinkError("Send ports as a list, for example [3000].");
  if (value.length > LINK_PORTS_MAX) throw new LinkError(`Link at most ${LINK_PORTS_MAX} ports in one call.`);
  const ports = value.map(linkPort);
  if (new Set(ports).size !== ports.length) throw new LinkError("Each port must appear only once.");
  return ports;
}

/** @param {unknown} value @returns {"ssh" | "relay"} */
export function linkRoute(value) {
  if (value === undefined) return "ssh";
  if (value !== "ssh" && value !== "relay") throw new LinkError("route is ssh or relay.");
  return value;
}

/** A host name or an IP address. The runner puts it in a device shell command, so the rule is strict. */
/** @param {unknown} value @returns {string} */
export function netCheckHost(value) {
  if (typeof value !== "string") throw new LinkError("Send a host name or an IP address.");
  const host = value.replace(/^\[(.*)\]$/, "$1");
  const name = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
  const ipv6 = /^[0-9A-Fa-f:.]{2,45}$/;
  if (!name.test(host) && !(host.includes(":") && ipv6.test(host))) throw new LinkError("The host is not a valid host name or IP address.");
  return host;
}

/** "host:port", "[v6]:port" or a URL. Returns { host, port }. */
/** @param {unknown} value @returns {{ host: string, port: number }} */
export function parseTarget(value) {
  if (typeof value !== "string" || !value || value.length > 300) throw new LinkError("Send target=host:port, for example target=localhost:3000.");
  let text = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url;
    try { url = new URL(text); } catch { throw new LinkError("The target URL is not valid."); }
    const port = url.port || /** @type {Record<string, string>} */ ({ "http:": "80", "https:": "443", "ws:": "80", "wss:": "443" })[url.protocol];
    if (!port) throw new LinkError("Add a port to the target, for example localhost:3000.");
    text = `${url.hostname}:${port}`;
  }
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(text);
  if (!match) throw new LinkError("Send target=host:port, for example target=localhost:3000.");
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw new LinkError("The port is a whole number from 1 to 65535.");
  return { host: netCheckHost(match[1]), port };
}

/** OPEN carries the phone-side port; DATA carries bytes; CLOSE has no body. */
/** @param {number} type @param {number} id @param {any} [body] @returns {Buffer} */
export function encodeFrame(type, id, body) {
  const extra = type === FRAME.OPEN ? 2 : type === FRAME.DATA ? body.length : 0;
  const frame = Buffer.allocUnsafe(5 + extra);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(id, 1);
  if (type === FRAME.OPEN) frame.writeUInt16BE(body, 5);
  else if (type === FRAME.DATA) body.copy(frame, 5);
  return frame;
}

/** Returns undefined for a frame that is too short or has an unknown type. */
/** @param {Buffer | ArrayBuffer | Uint8Array} data */
export function decodeFrame(data) {
  const frame = Buffer.isBuffer(data) ? data : Buffer.from(/** @type {ArrayBuffer} */ (data));
  if (frame.length < 5) return;
  const type = frame.readUInt8(0), id = frame.readUInt32BE(1);
  if (type === FRAME.OPEN) return frame.length === 7 ? { type, id, port: frame.readUInt16BE(5) } : undefined;
  if (type === FRAME.DATA) return { type, id, data: frame.subarray(5) };
  if (type === FRAME.CLOSE) return { type, id };
}

/** Ports in LISTEN state, from the text of /proc/net/tcp or /proc/net/tcp6. */
/** @param {string} text */
export function listeningPorts(text) {
  const ports = new Set();
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[3] !== "0A") continue;
    const port = parseInt(fields[1].split(":").pop() ?? "", 16);
    if (Number.isInteger(port)) ports.add(port);
  }
  return ports;
}

const LOGCAT_RULES = [
  { kind: "refused", pattern: /ECONNREFUSED|Connection refused|Failed to connect to/i,
    hint: "The app could not connect to its server. Check the address with GET /v1/phones/<id>/net-check?target=host:port." },
  // Case-sensitive: /ENOTFOUND/i also matches "ServiceNotFoundException".
  { kind: "dns", pattern: /UnknownHostException|Unable to resolve host|\bENOTFOUND\b|\bEAI_NODATA\b|\bEAI_NONAME\b/,
    hint: "The phone cannot resolve this host name. Point the app at localhost:<port>, then run emuly link <phone> <port> --to <host>:<port>." },
  { kind: "cleartext", pattern: /CLEARTEXT communication.*not permitted/i,
    hint: "Android blocks plain HTTP for this host. Allow cleartext for it in the app's network security config, or use HTTPS." },
  { kind: "timeout", pattern: /SocketTimeoutException|ETIMEDOUT|connect timed out/i,
    hint: "The connection timed out. The phone cannot reach this address. Check it with net-check." },
];

/** Brief-format tags ("E/tag ( pid):") that are never the app. */
const SYSTEM_TAGS = /^\s*[VDIWEF]\/(?:adbd|resolv|DnsResolver|netd|ConnectivityService|NetworkMonitor\S*|SystemServiceRegistry|scrcpy|wificond|WifiService)\s*\(/;

/** Connection errors in a logcat dump. At most `limit` different lines, newest last. */
/** @param {string} text @returns {{ kind: string, line: string, hint: string, target?: string }[]} */
export function logcatHints(text, limit = 10) {
  const found = new Map();
  for (const line of text.split("\n")) {
    // Android's own network stack and the scrcpy video socket log these errors all the time.
    if (SYSTEM_TAGS.test(line)) continue;
    const rule = LOGCAT_RULES.find(item => item.pattern.test(line));
    if (!rule) continue;
    const clean = line.trim().slice(0, 300);
    const target = /(?:to|connect to|host)\s+"?\/?([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])(?:\/[0-9a-fA-F.:]+)?(?:\s*\(port (\d+)\)|:(\d+))/.exec(clean);
    const key = `${rule.kind}:${clean.replace(/^\S+\s+\S+\s+/, "")}`;
    found.delete(key);
    found.set(key, { kind: rule.kind, line: clean, hint: rule.hint,
      ...(target ? { target: `${target[1]}${target[2] || target[3] ? `:${target[2] || target[3]}` : ""}` } : {}) });
  }
  return [...found.values()].slice(-limit);
}

/**
 * A URL to a server that the phone cannot reach without a link: loopback, the emulator host,
 * private LAN, CGNAT/Tailscale, or a .ts.net/.local/.lan/.internal name.
 * POSIX ERE, so `grep -E` and JavaScript both read it.
 */
export const LOCAL_SERVER_URL = "(https?|wss?)://(localhost|127\\.0\\.0\\.1|10(\\.[0-9]{1,3}){3}|192\\.168(\\.[0-9]{1,3}){2}"
  + "|172\\.(1[6-9]|2[0-9]|3[01])(\\.[0-9]{1,3}){2}|100(\\.[0-9]{1,3}){3}"
  + "|[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*\\.(ts\\.net|local|lan|internal))(:[0-9]{1,5})?";

/**
 * Server URLs that an APK has inside it, one per line of `grep -o` output. At most `limit`.
 * @param {string} text @returns {{ url: string, host: string, port: number }[]}
 */
export function localServerUrls(text, limit = 10) {
  const pattern = new RegExp(`^${LOCAL_SERVER_URL}$`);
  const found = new Map();
  for (const line of text.split("\n")) {
    const url = line.trim();
    if (!pattern.test(url) || found.has(url)) continue;
    const parsed = /^(\w+):\/\/([^:/]+)(?::(\d+))?$/.exec(url);
    if (!parsed) continue;
    const port = parsed[3] ? Number(parsed[3]) : /^(https|wss)$/.test(parsed[1]) ? 443 : 80;
    if (port < 1 || port > 65535) continue;
    found.set(url, { url, host: parsed[2], port });
    if (found.size >= limit) break;
  }
  return [...found.values()];
}

/**
 * Reads the net-check shell output: `exit=N`, `bytes=N`, then nc's stderr.
 * Reachable: a reply came (bytes > 0), or the connection stayed open and silent (timeout, 124).
 * Not reachable: an nc error, or a close with no reply. A link's tunnel does the second when
 * nothing listens on the laptop: it accepts the connection, then closes it.
 */
/** @param {unknown} output @returns {{ reachable: boolean, detail: string }} */
export function netCheckResult(output) {
  const text = String(output);
  const code = Number(/exit=(\d+)/.exec(text)?.[1] ?? -1);
  const bytes = Number(/bytes=\s*(\d+)/.exec(text)?.[1] ?? 0);
  const detail = text.replace(/exit=\d+\s*/, "").replace(/bytes=\s*\d+\s*/, "").trim().slice(0, 200);
  const failed = /refused|unreachable|bad address|timeout|timed out|no route|unknown host|resolve/i.test(detail);
  if (!failed && (bytes > 0 || code === 124)) return { reachable: true, detail: "" };
  if (!failed && (code === 0 || code === 1)) {
    return { reachable: false, detail: "The connection closed with no reply. For a link, nothing listens on that port of the laptop. Start the server there." };
  }
  return { reachable: false, detail: detail || `nc exit ${code}` };
}
