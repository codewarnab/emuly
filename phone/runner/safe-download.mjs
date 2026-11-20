import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";

// One downloader for every URL the runner fetches for an agent (APK installs, file fetches).
// The agent can read the result back from the phone, so a bad check here leaks anything the
// runner can reach: its own API on 127.0.0.1, cloud metadata, Tailscale, private networks.
// Rules: HTTPS on 443 only, no URL credentials, every DNS answer public, the socket pinned to
// the checked address, each redirect checked again, a byte limit while streaming, no cookies
// or auth headers, no compressed bodies.

export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
/** @returns {never} */
export function fail(status, code, message) { throw new AppError(status, code, message); }

/** Permit ordinary global addresses only, including strict handling of IPv6 transition ranges. */
export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b))
      || (a === 203 && b === 0));
  }
  if (isIP(address) !== 6) return false;
  const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  if (!/^[23][0-9a-f]{3}:/.test(normalized) || normalized.startsWith("2002:") || normalized.startsWith("3fff:")) return false;
  const [first, second] = normalized.split(":");
  return first !== "2001" || (parseInt(second || "0", 16) >= 0x200 && !normalized.startsWith("2001:db8:"));
}

/** An HTTPS URL on port 443 with no credentials and no fragment. */
export function httpsUrl(input, message = "Enter a direct HTTPS download URL.") {
  if (typeof input !== "string" || input.length > 4096) fail(400, "invalid_url", message);
  let url;
  try { url = new URL(input); } catch { fail(400, "invalid_url", message); }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.hash)
    fail(400, "invalid_url", "Use HTTPS on port 443 without URL credentials or fragments.");
  return url;
}

async function responseFor(url, signal, accept, userAgent, lookup) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address)))
    fail(400, "private_url", "The download URL must resolve to public addresses.");
  const chosen = addresses[0];
  return new Promise((resolve, reject) => {
    // agent: false: no shared socket pool, so no socket that another lookup opened is reused.
    const req = request(url, { signal, agent: false, family: chosen.family,
      lookup: (_host, _options, callback) => callback(null, chosen.address, chosen.family),
      headers: { Accept: accept, "Accept-Encoding": "identity", ...(userAgent ? { "User-Agent": userAgent } : {}) },
    }, response => { clearTimeout(connectTimeout); resolve(response); });
    const connectTimeout = setTimeout(() => req.destroy(new Error("Download connection timeout")), 30_000);
    req.setTimeout(30_000, () => req.destroy(new Error("Download idle timeout")));
    req.on("error", error => { clearTimeout(connectTimeout); reject(error); });
    req.end();
  });
}

/**
 * Streams one public HTTPS URL into `write`. Each redirect gets fresh DNS validation and a
 * socket pinned to the checked address. `messages` lets a caller name its own file kind.
 * Returns the final URL and the response content type.
 * @param {string} input
 * @param {{ signal: AbortSignal, maxBytes: number, write: (bytes: Buffer, total: number | null) => Promise<void>,
 *   accept?: string, userAgent?: string, lookup?: any,
 *   messages?: { tooLarge?: string, encoded?: string, status?: (status: number) => string } }} options
 */
export async function safeDownload(input, { signal, maxBytes, write, accept = "*/*", userAgent, lookup = dnsLookup,
  messages = {} }) {
  const tooLarge = messages.tooLarge ?? `The file must be ${Math.floor(maxBytes / (1024 * 1024))} MiB or smaller.`;
  let url = httpsUrl(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const response = await responseFor(url, signal, accept, userAgent, lookup);
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || redirects === 5) fail(400, "redirect_limit", "The download has too many redirects.");
      url = httpsUrl(new URL(location, url).href);
      continue;
    }
    if (status !== 200) {
      response.destroy();
      fail(502, "download_failed", messages.status?.(status) ?? `The download server answered HTTP ${status}. Check the link.`);
    }
    const length = Number(response.headers["content-length"]);
    if (length > maxBytes) { response.destroy(); fail(413, "too_large", tooLarge); }
    if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
      response.destroy(); fail(400, "encoded_download", messages.encoded ?? "Use a direct, uncompressed download.");
    }
    let received = 0;
    for await (const chunk of response) {
      received += chunk.length;
      if (received > maxBytes) { response.destroy(); fail(413, "too_large", tooLarge); }
      await write(chunk, Number.isSafeInteger(length) && length > 0 ? length : null);
    }
    return { url: url.href, bytes: received, contentType: String(response.headers["content-type"] ?? "").slice(0, 200) };
  }
  fail(400, "redirect_limit", "The download has too many redirects.");
}
