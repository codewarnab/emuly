// Signed tickets for the direct (public) stream port. Emuly signs; the runner checks.
// The same file runs on the server (lib/phone/direct-ticket.ts) and in the codespace.
// Format: base64url(JSON payload) "." base64url(HMAC-SHA256(ticketKey, payload part)).
import { createHmac, timingSafeEqual } from "node:crypto";

export const TICKET_TTL_MS = 30_000;
const KEY_LABEL = "emuly-direct-ticket-v1";
const MAX_TICKET_LENGTH = 2048;

/** The ticket key comes from the phone key, so a leaked ticket key does not give the phone key. */
export function ticketKey(phoneKey) {
  if (typeof phoneKey !== "string" || !/^[0-9a-f]{64}$/.test(phoneKey)) throw new Error("invalid phone key");
  return createHmac("sha256", Buffer.from(phoneKey, "hex")).update(KEY_LABEL).digest();
}

const mac = (key, part) => createHmac("sha256", key).update(part).digest();

/** payload: { codespace, phoneId, userId, sessionId, quality, origin, nonce, exp } */
export function signTicket(phoneKey, payload) {
  const part = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${part}.${mac(ticketKey(phoneKey), part).toString("base64url")}`;
}

/**
 * Checks in a fixed order: signature, expiry, codespace, nonce, origin.
 * Returns { ok: true, payload } or { ok: false, reason }. Callers never show the reason to the client.
 */
export function verifyTicket(phoneKey, ticket, { codespace, origin, nonces, now = Date.now() }) {
  if (typeof ticket !== "string" || ticket.length > MAX_TICKET_LENGTH) return { ok: false, reason: "format" };
  const dot = ticket.indexOf(".");
  if (dot < 1 || dot !== ticket.lastIndexOf(".")) return { ok: false, reason: "format" };
  const part = ticket.slice(0, dot);
  const given = Buffer.from(ticket.slice(dot + 1), "base64url");
  const expected = mac(ticketKey(phoneKey), part);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "signature" };
  let payload;
  try { payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")); }
  catch { return { ok: false, reason: "format" }; }
  if (!payload || typeof payload !== "object") return { ok: false, reason: "format" };
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= now || payload.exp > now + TICKET_TTL_MS + 5_000) return { ok: false, reason: "expired" };
  if (payload.codespace !== codespace) return { ok: false, reason: "phone" };
  if (typeof payload.nonce !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(payload.nonce) || !nonces.claim(payload.nonce, payload.exp, now)) {
    return { ok: false, reason: "replay" };
  }
  if (typeof payload.origin !== "string" || payload.origin !== origin) return { ok: false, reason: "origin" };
  return { ok: true, payload };
}

/** Remembers each nonce until its ticket expires. A full store refuses new tickets (fail closed). */
export function createNonceStore(limit = 10_000) {
  const seen = new Map();
  return {
    claim(nonce, exp, now = Date.now()) {
      for (const [key, until] of seen) if (until <= now) seen.delete(key);
      if (seen.has(nonce) || seen.size >= limit) return false;
      seen.set(nonce, exp);
      return true;
    },
    get size() { return seen.size; },
  };
}

/** At most `max` tries per key in each window. */
export function createRateLimiter({ max = 20, windowMs = 60_000 } = {}) {
  const tries = new Map();
  return function allow(key, now = Date.now()) {
    if (tries.size > 10_000) for (const [k, v] of tries) if (v.until <= now) tries.delete(k);
    const entry = tries.get(key);
    if (!entry || entry.until <= now) { tries.set(key, { count: 1, until: now + windowMs }); return true; }
    return ++entry.count <= max;
  };
}

// Upload tickets: one adb file command on `PUT /adb` of the direct port. A separate key label,
// so a stream ticket never opens an upload and an upload ticket never opens a stream.
export const UPLOAD_TICKET_TTL_MS = 60_000;
const UPLOAD_KEY_LABEL = "emuly-upload-ticket-v1";
const MAX_UPLOAD_TICKET_LENGTH = 16_384;

function uploadKey(phoneKey) {
  if (typeof phoneKey !== "string" || !/^[0-9a-f]{64}$/.test(phoneKey)) throw new Error("invalid phone key");
  return createHmac("sha256", Buffer.from(phoneKey, "hex")).update(UPLOAD_KEY_LABEL).digest();
}

/** payload: { kind: "upload", codespace, phoneId, userId, args, timeout_s, files: [{ name, size, sha256 }], nonce, exp } */
export function signUploadTicket(phoneKey, payload) {
  const part = Buffer.from(JSON.stringify({ ...payload, kind: "upload" })).toString("base64url");
  return `${part}.${mac(uploadKey(phoneKey), part).toString("base64url")}`;
}

/**
 * Checks signature, kind, expiry, codespace, file list, then nonce (last, so a bad ticket does not use a nonce slot).
 * Returns { ok: true, payload } or { ok: false, reason }.
 */
export function verifyUploadTicket(phoneKey, ticket, { codespace, nonces, now = Date.now() }) {
  if (typeof ticket !== "string" || ticket.length > MAX_UPLOAD_TICKET_LENGTH) return { ok: false, reason: "format" };
  const dot = ticket.indexOf(".");
  if (dot < 1 || dot !== ticket.lastIndexOf(".")) return { ok: false, reason: "format" };
  const part = ticket.slice(0, dot);
  const given = Buffer.from(ticket.slice(dot + 1), "base64url");
  const expected = mac(uploadKey(phoneKey), part);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "signature" };
  let payload;
  try { payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")); }
  catch { return { ok: false, reason: "format" }; }
  if (!payload || typeof payload !== "object" || payload.kind !== "upload") return { ok: false, reason: "format" };
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= now || payload.exp > now + UPLOAD_TICKET_TTL_MS + 5_000) return { ok: false, reason: "expired" };
  if (payload.codespace !== codespace) return { ok: false, reason: "phone" };
  if (!Array.isArray(payload.args) || !Array.isArray(payload.files) || !payload.files.length
    || !payload.files.every(file => file && typeof file.name === "string" && Number.isSafeInteger(file.size) && file.size >= 0
      && typeof file.sha256 === "string" && /^[0-9a-f]{64}$/.test(file.sha256))) return { ok: false, reason: "format" };
  if (typeof payload.nonce !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(payload.nonce) || !nonces.claim(payload.nonce, payload.exp, now)) {
    return { ok: false, reason: "replay" };
  }
  return { ok: true, payload };
}

// Chunk tickets: the browser PUTs APK chunks of one Apps installation to
// `PUT /app-installs/<operationId>/content` on the direct port. A separate key label, so a
// chunk ticket never opens a stream or an adb upload. One ticket covers every chunk of one
// operation, so it has no nonce. It is bound to the operation, the codespace and the page origin.
export const CHUNK_TICKET_TTL_MS = 600_000;
const CHUNK_KEY_LABEL = "emuly-chunk-ticket-v1";

function chunkKey(phoneKey) {
  if (typeof phoneKey !== "string" || !/^[0-9a-f]{64}$/.test(phoneKey)) throw new Error("invalid phone key");
  return createHmac("sha256", Buffer.from(phoneKey, "hex")).update(CHUNK_KEY_LABEL).digest();
}

/** payload: { codespace, phoneId, userId, operationId, origin, exp } */
export function signChunkTicket(phoneKey, payload) {
  const part = Buffer.from(JSON.stringify({ ...payload, kind: "chunk" })).toString("base64url");
  return `${part}.${mac(chunkKey(phoneKey), part).toString("base64url")}`;
}

/**
 * Checks signature, kind, expiry, codespace, operation and origin.
 * Returns { ok: true, payload } or { ok: false, reason }. Callers never show the reason to the client.
 */
export function verifyChunkTicket(phoneKey, ticket, { codespace, operationId, origin, now = Date.now() }) {
  if (typeof ticket !== "string" || ticket.length > MAX_TICKET_LENGTH) return { ok: false, reason: "format" };
  const dot = ticket.indexOf(".");
  if (dot < 1 || dot !== ticket.lastIndexOf(".")) return { ok: false, reason: "format" };
  const part = ticket.slice(0, dot);
  const given = Buffer.from(ticket.slice(dot + 1), "base64url");
  const expected = mac(chunkKey(phoneKey), part);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "signature" };
  let payload;
  try { payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")); }
  catch { return { ok: false, reason: "format" }; }
  if (!payload || typeof payload !== "object" || payload.kind !== "chunk") return { ok: false, reason: "format" };
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= now || payload.exp > now + CHUNK_TICKET_TTL_MS + 5_000) return { ok: false, reason: "expired" };
  if (payload.codespace !== codespace) return { ok: false, reason: "phone" };
  if (typeof operationId !== "string" || payload.operationId !== operationId) return { ok: false, reason: "operation" };
  if (typeof payload.origin !== "string" || payload.origin !== origin) return { ok: false, reason: "origin" };
  return { ok: true, payload };
}
