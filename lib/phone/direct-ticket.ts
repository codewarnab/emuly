import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { signTicket, TICKET_TTL_MS } from "../../phone/runner/direct-ticket.mjs";

/**
 * The phone key for one codespace. It comes from EMULY_DIRECT_SECRET, so Emuly stores no
 * key per phone. With no secret there is no key, and the runner keeps port 8791 closed.
 */
export function phoneDirectKey(codespaceName: string, secret = process.env.EMULY_DIRECT_SECRET): string | undefined {
  if (!secret || secret.length < 32 || !/^[\w-]{1,100}$/.test(codespaceName)) return undefined;
  return createHmac("sha256", secret).update(`emuly-direct-phone-v1:${codespaceName}`).digest("hex");
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
