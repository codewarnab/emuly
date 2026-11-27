import "server-only";
import { isCodespaceName } from "../shared/codespace-name.ts";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { CHUNK_TICKET_TTL_MS, signChunkTicket, signTicket, signUploadTicket, TICKET_TTL_MS, UPLOAD_TICKET_TTL_MS } from "../../phone/runner/direct-ticket.mjs";

/**
 * The phone key for one codespace. It comes from EMULY_DIRECT_SECRET, so Emuly stores no
 * key per phone. With no secret there is no key, and the runner keeps port 8791 closed.
 */
export function phoneDirectKey(codespaceName: string, secret = process.env.EMULY_DIRECT_SECRET): string | undefined {
  if (!secret || secret.length < 32 || !isCodespaceName(codespaceName)) return undefined;
  return createHmac("sha256", secret).update(`emuly-direct-phone-v1:${codespaceName}`).digest("hex");
}

/**
 * The runner key for one codespace: the second lock on the private port 8790 (phone/runner/runner-key.mjs).
 * Derived from EMULY_DIRECT_SECRET with its own label, so it differs from the direct key and Emuly stores nothing.
 * Undefined without the secret: then the runner has no key file and port privacy is the only lock.
 */
export function runnerSecret(codespaceName: string, secret = process.env.EMULY_DIRECT_SECRET): string | undefined {
  if (!secret || secret.length < 32 || !isCodespaceName(codespaceName)) return undefined;
  return createHmac("sha256", secret).update(`emuly-runner-key-v1:${codespaceName}`).digest("hex");
}

/** What the runner reports as `key` in GET /health: 8 hex of sha256(key), or null with no key. */
export function runnerKeyFingerprint(key: string | undefined): string | null {
  return key ? createHash("sha256").update(key, "utf8").digest("hex").slice(0, 8) : null;
}

/** The content of ~/emuly/.direct-key in the codespace. */
export function directKeyFile(codespaceName: string, secret?: string) {
  const key = phoneDirectKey(codespaceName, secret);
  return key ? `${key}\n${codespaceName}\n` : undefined;
}

export type DirectTicketInput = { codespaceName: string; phoneId: string; userId: number; sessionId: string; quality: string; origin: string };

/** A one-time ticket for `wss://<codespace>-8791.app.github.dev/stream`. Valid for 30 s. */
export function issueDirectTicket(input: DirectTicketInput, { secret, now = Date.now() }: { secret?: string; now?: number } = {}) {
  const key = phoneDirectKey(input.codespaceName, secret);
  if (!key) return undefined;
  return signTicket(key, { codespace: input.codespaceName, phoneId: input.phoneId, userId: input.userId,
    sessionId: input.sessionId, quality: input.quality, origin: input.origin,
    nonce: randomBytes(18).toString("base64url"), exp: now + TICKET_TTL_MS }) as string;
}

export type UploadFile = { name: string; size: number; sha256: string };
export type UploadTicketInput = { codespaceName: string; phoneId: string; userId: number; args: string[]; timeout_s: number; files: UploadFile[] };

/** A one-time ticket for `PUT https://<codespace>-8791.app.github.dev/adb`. Valid for 60 s. It locks the args and each file's size and hash. */
export function issueUploadTicket(input: UploadTicketInput, { secret, now = Date.now() }: { secret?: string; now?: number } = {}) {
  const key = phoneDirectKey(input.codespaceName, secret);
  if (!key) return undefined;
  const exp = now + UPLOAD_TICKET_TTL_MS;
  const ticket = signUploadTicket(key, { codespace: input.codespaceName, phoneId: input.phoneId, userId: input.userId,
    args: input.args, timeout_s: input.timeout_s, files: input.files.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
    nonce: randomBytes(18).toString("base64url"), exp }) as string;
  return { ticket, exp };
}

export type ChunkTicketInput = { codespaceName: string; phoneId: string; userId: number; operationId: string; origin: string };

/**
 * A ticket for `PUT https://<codespace>-8791.app.github.dev/app-installs/<operationId>/content` from the browser.
 * Valid for 10 min and for every chunk of that one operation, from that one page origin.
 */
export function issueChunkTicket(input: ChunkTicketInput, { secret, now = Date.now() }: { secret?: string; now?: number } = {}) {
  const key = phoneDirectKey(input.codespaceName, secret);
  if (!key) return undefined;
  const exp = now + CHUNK_TICKET_TTL_MS;
  const ticket = signChunkTicket(key, { codespace: input.codespaceName, phoneId: input.phoneId, userId: input.userId,
    operationId: input.operationId, origin: input.origin, exp }) as string;
  return { ticket, exp };
}
