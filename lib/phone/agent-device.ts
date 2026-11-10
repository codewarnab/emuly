import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/** The agent-device CLI talks to /v1/phones/<id>/agent-device-proxy/agent-device/<path>.
    These helpers keep the public URL, the internal path and the relayed headers in one place. */

export type AgentDeviceInfo = { token: string; version: string | null };

/** Headers that describe one hop, carry the browser session, or name the runner's own credential. */
const SKIPPED_HEADERS = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer",
  "cookie", "proxy-authorization", "proxy-connection", "x-phone-secret", "x-github-token", "forwarded"]);

/** The public proxy URL handed to the CLI; it reaches this app, not the codespace. */
export function agentDeviceBaseUrl(baseUrl: string, id: string) {
  return `${baseUrl.replace(/\/+$/, "")}/v1/phones/${encodeURIComponent(id)}/agent-device-proxy/agent-device`;
}

/** One CLI session per phone, so a token relayed for one phone is not used for another. */
export function agentDeviceSession(id: string) {
  return `emuly-${id}`;
}

/** The runner reports readiness and its own token; anything else never becomes a proxy URL. */
export function agentDeviceInfo(value: unknown): AgentDeviceInfo | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.ready !== true) return null;
  const token = record.token;
  if (typeof token !== "string" || !token || token.length > 512) return null;
  const version = typeof record.version === "string" && record.version.length <= 64 ? record.version : null;
  return { token, version };
}

/** What the database stores instead of the proxy token: its sha256 hex digest. */
export function agentDeviceTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time check of a presented bearer against the stored digest. A missing or malformed digest never matches. */
export function agentDeviceTokenMatches(hash: string | null | undefined, token: string) {
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return false;
  return timingSafeEqual(createHash("sha256").update(token).digest(), Buffer.from(hash, "hex"));
}

/** The same answer for a missing phone, a stopped phone and a runner without the route. */
export function agentDeviceUnavailable() {
  return Response.json({ error: "agent-device is not available on this phone" },
    { status: 404, headers: { "Cache-Control": "no-store" } });
}

/** Builds the runner path from decoded catch-all segments. Null means the URL is not safe to relay. */
export function agentDevicePath(segments: readonly string[], search = ""): string | null {
  if (segments.length < 1 || segments.length > 64) return null;
  const encoded: string[] = [];
  for (const segment of segments) {
    // `..` is not encoded by encodeURIComponent, and a separator inside a segment is ambiguous.
    if (typeof segment !== "string" || !segment || segment.length > 512) return null;
    if (segment === "." || segment === ".." || /[/\\\u0000]/.test(segment)) return null;
    try { encoded.push(encodeURIComponent(segment)); }
    catch { return null; }
  }
  if (search && (!search.startsWith("?") || /[\u0000-\u001f\u007f#]/.test(search))) return null;
  return `/agent-device/${encoded.join("/")}${search}`;
}

/** The proxy token is a bearer credential; a cookie or a bare value is not one. */
export function bearerToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match ? match[1] : null;
}

const COMMAND = /^[a-z][a-z0-9_.:-]{0,39}$/i;

/** The command name for the activity log, such as `press`. Never refs, selectors, typed text or file data. */
export function agentDeviceCommand(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const params = record.params && typeof record.params === "object" ? record.params as Record<string, unknown> : {};
  for (const value of [params.command, params.cmd, record.command, record.method]) {
    if (typeof value === "string" && COMMAND.test(value)) return value;
  }
  return null;
}

/** Replays the request without hop-by-hop, session or runner-credential headers. Never logs values. */
export function proxyRequestHeaders(input: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of input) {
    const key = name.toLowerCase();
    if (SKIPPED_HEADERS.has(key) || key.startsWith("proxy-") || key.startsWith("x-forwarded-")) continue;
    headers.set(key, value);
  }
  return headers;
}
