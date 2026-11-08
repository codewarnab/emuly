import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";

export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
/** @returns {never} */
export function fail(status, code, message) { throw new AppError(status, code, message); }

// Permit ordinary global addresses only, including strict handling of IPv6 transition ranges.
function publicAddress(address) {
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

export function apkUrl(input) {
  if (typeof input !== "string" || input.length > 4096) fail(400, "invalid_url", "Enter a direct HTTPS download URL.");
  let url;
  try { url = new URL(input); } catch { fail(400, "invalid_url", "Enter a direct HTTPS download URL."); }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.hash)
    fail(400, "invalid_url", "Use HTTPS on port 443 without URL credentials or fragments.");
  return url;
}

async function responseFor(url, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address)))
    fail(400, "private_url", "The download URL must resolve to public addresses.");
  const chosen = addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(url, { signal, agent: false, family: chosen.family,
      lookup: (_host, _options, callback) => callback(null, chosen.address, chosen.family),
      headers: { Accept: "application/vnd.android.package-archive, application/octet-stream", "Accept-Encoding": "identity" },
    }, response => { clearTimeout(connectTimeout); resolve(response); });
    const connectTimeout = setTimeout(() => req.destroy(new Error("Download connection timeout")), 30_000);
    req.setTimeout(30_000, () => req.destroy(new Error("Download idle timeout")));
    req.on("error", error => { clearTimeout(connectTimeout); reject(error); });
    req.end();
  });
}

/** Each redirect gets fresh DNS validation and a socket pinned to the checked address. */
export async function downloadApk(input, { signal, maxBytes, write }) {
  let url = apkUrl(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const response = await responseFor(url, signal);
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || redirects === 5) fail(400, "redirect_limit", "The download has too many redirects.");
      url = apkUrl(new URL(location, url).href);
      continue;
    }
    if (status !== 200) { response.destroy(); fail(502, "download_failed", "The download server did not return an APK. Check the link."); }
    const length = Number(response.headers["content-length"]);
    if (length > maxBytes) { response.destroy(); fail(413, "too_large", "APK files must be 250 MiB or smaller."); }
    if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
      response.destroy(); fail(400, "encoded_download", "Use a direct, uncompressed APK download.");
    }
    let received = 0;
    for await (const chunk of response) {
      received += chunk.length;
      if (received > maxBytes) { response.destroy(); fail(413, "too_large", "APK files must be 250 MiB or smaller."); }
      await write(chunk, Number.isSafeInteger(length) && length > 0 ? length : null);
    }
    if (!received) fail(400, "empty_apk", "The downloaded file is empty.");
    return;
  }
}
