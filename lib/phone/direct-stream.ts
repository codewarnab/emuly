import "server-only";
import { getAccessToken } from "../github/github-token.ts";
import { makeDirectPortPublic } from "../github/codespace-tunnel.ts";
import { issueDirectTicket } from "./direct-ticket.ts";

/** EMULY_DIRECT_STREAM: "off" (default), "all", or a comma list of user ids. */
export function directStreamEnabled(userId: number, flag = process.env.EMULY_DIRECT_STREAM ?? "off") {
  if (!process.env.EMULY_DIRECT_SECRET) return false;
  if (flag === "all") return true;
  return flag.split(",").map(item => item.trim()).includes(String(userId));
}

const PUBLIC_WAIT_MS = 2_500;
const g = globalThis as unknown as { __directPorts?: Map<string, Promise<boolean>> };
const ports = () => g.__directPorts ??= new Map();

/** One public-port call per codespace per server instance. A failure is forgotten, so a later ticket tries again. */
export function ensureDirectPort(userId: number, codespaceName: string, publish = makeDirectPortPublic, token = getAccessToken) {
  let pending = ports().get(codespaceName);
  if (!pending) {
    pending = token(userId).then(secret => publish(secret, codespaceName, AbortSignal.timeout(15_000))).catch(() => false);
    pending.then((ok: boolean) => { if (!ok) ports().delete(codespaceName); });
    ports().set(codespaceName, pending);
  }
  return pending;
}

export type DirectStream = { url: string; ticket: string };

/** The direct URL and ticket, or undefined when the browser must use the Vercel path. */
export async function directStream(input: { userId: number; phoneId: string; codespaceName: string; sessionId: string; quality: string; origin: string },
  { ensure = ensureDirectPort, waitMs = PUBLIC_WAIT_MS }: { ensure?: typeof ensureDirectPort; waitMs?: number } = {}): Promise<DirectStream | undefined> {
  if (!directStreamEnabled(input.userId)) return undefined;
  // The first ticket waits a short time. If the port is not public yet, this view uses Vercel.
  const ready = await Promise.race([ensure(input.userId, input.codespaceName),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), waitMs))]);
  if (!ready) return undefined;
  const ticket = issueDirectTicket({ ...input });
  return ticket ? { url: `wss://${input.codespaceName}-8791.app.github.dev`, ticket } : undefined;
}
