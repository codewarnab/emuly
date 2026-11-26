import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { publicOnly } from "../../phone/runner/ip-policy.mjs";

export class WebhookInputError extends Error {}
export type ResolveHost = (host: string) => Promise<{ address: string; family: number }[]>;
export type WebhookTarget = { url: URL; addresses: { address: string; family: number }[] };
export const resolveHost: ResolveHost = host => lookup(host, { all: true, verbatim: true });

/** Public unicast IPv4 or global IPv6 only (ip-policy.mjs). Shared with the codespace region hint. */
export const publicAddress = (address: string): boolean => publicOnly(address);

/** Validate all DNS answers at registration and immediately before each send. */
export async function webhookTarget(value: unknown, baseUrl: string, resolve: ResolveHost = resolveHost): Promise<WebhookTarget> {
  if (typeof value !== "string" || value.length > 2048) throw new WebhookInputError("Enter an HTTPS URL.");
  let url: URL;
  try { url = new URL(value); } catch { throw new WebhookInputError("Enter an HTTPS URL."); }
  if (url.username || url.password || url.hash) throw new WebhookInputError("URL credentials and fragments are not allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = new URL(baseUrl).hostname === "localhost" && host === "localhost";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new WebhookInputError("Use HTTPS. HTTP localhost requires Emuly itself to use localhost.");
  }
  let addresses: WebhookTarget["addresses"];
  try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host); }
  catch { throw new WebhookInputError("The webhook hostname could not be resolved."); }
  if (!addresses.length || addresses.some(({ address }) => local
    ? !(address === "::1" || /^127\./.test(address)) : !publicAddress(address))) {
    throw new WebhookInputError("The webhook must resolve to public addresses.");
  }
  return { url, addresses };
}

export function signWebhook(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Verify the raw body before parsing; reject old and future timestamps. */
export function verifyWebhook(secret: string, body: string, header: string, clock: () => number = Date.now): boolean {
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(header);
  if (!match || Math.abs(Math.floor(clock() / 1000) - Number(match[1])) > 300) return false;
  const expected = signWebhook(secret, body, Number(match[1])).split("v1=")[1]!;
  return timingSafeEqual(Buffer.from(match[2]!, "hex"), Buffer.from(expected, "hex"));
}

export type SendWebhook = (target: WebhookTarget, body: string, headers: Record<string, string>, signal: AbortSignal) => Promise<number>;

/** Pin the checked address to the socket, keeping the hostname for TLS and Host.
 * Native HTTP never follows redirects. Receiver response bodies are discarded.
 */
export const sendWebhook: SendWebhook = (target, body, headers, signal) => new Promise((resolve, reject) => {
  const address = target.addresses[0]!;
  const request = (target.url.protocol === "https:" ? httpsRequest : httpRequest)(target.url, {
    method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, signal,
    lookup: (_host, _options, callback) => callback(null, address.address, address.family),
    family: address.family, agent: false,
  }, response => {
    resolve(response.statusCode ?? 0);
    response.destroy();
  });
  request.on("error", reject);
  request.end(body);
});
