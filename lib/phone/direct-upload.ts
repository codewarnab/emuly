import "server-only";
import { PORTS, runnerHost } from "../../phone/runner/contracts.mjs";
import { ensureDirectPort } from "./direct-stream.ts";
import { issueUploadTicket, type UploadFile } from "./direct-ticket.ts";
import { findPhone } from "./phones.ts";

const PUBLIC_WAIT_MS = 15_000;

/**
 * A ticket for `PUT https://<codespace>-8791.app.github.dev/adb`. Large files go straight to the phone,
 * because Vercel refuses function bodies over 4.5 MB. Undefined when EMULY_DIRECT_SECRET is not set
 * or the port could not be made public.
 */
export async function directUploadTicket(userId: number, phoneId: string, input: { args: string[]; timeout_s: number; files: UploadFile[] },
  { ensure = ensureDirectPort, find = findPhone, secret = process.env.EMULY_DIRECT_SECRET, waitMs = PUBLIC_WAIT_MS } = {}) {
  if (!secret) return undefined;
  const phone = await find(userId, phoneId);
  if (!phone?.codespace_name) return undefined;
  const ready = await Promise.race([ensure(userId, phone.codespace_name),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), waitMs))]);
  if (!ready) return undefined;
  const issued = issueUploadTicket({ codespaceName: phone.codespace_name, phoneId, userId, ...input }, { secret });
  return issued ? { url: `https://${runnerHost(phone.codespace_name, PORTS.DIRECT)}/adb`, ...issued } : undefined;
}
