// The runner key: a second lock on the private port 8790, after GitHub's owner-only port privacy.
// Emuly derives one key per codespace (`runnerSecret` in lib/phone/direct-ticket.ts) and writes it to ~/emuly/.runner-key
// through the private SSH setup input. Every request except GET /health must send it as `x-phone-secret`.
//
// AUDIT, exact limits:
// - With no key file (self-host without EMULY_DIRECT_SECRET), the check is off and port privacy is the only lock.
//   This keeps old setups working. Anyone who can delete the file can already run code in the codespace.
// - A key file that exists but is unreadable or malformed fails closed: every request except /health gets 401,
//   and /health reports key "invalid", so Emuly runs setup again and writes a good file.
// - GET /health stays open: the setup script calls it with curl. It returns the runner version, busy counts,
//   and an 8-hex fingerprint of the key (32 bits of a hash of a 256-bit key) so Emuly can see a stale key.
// - It blocks callers that reach 127.0.0.1:8790 without the key, such as an app inside the emulator
//   (10.0.2.2 is the host loopback) or another process in the codespace that cannot read the file.
//   It does not block code that runs as the codespace user, which can read the file.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

const KEY = /^[0-9a-f]{64}$/;
/** @param {string} value */
const digest = value => createHash("sha256").update(value, "utf8").digest();

/** Reads the key file again at most every `pollMs`, and at once (rate-limited) after a wrong key, so a new key works without a restart. */
/** @param {{ file: string, pollMs?: number, retryMs?: number, read?: (path: string) => Promise<string>, now?: () => number }} options */
export function createRunnerKey({ file, pollMs = 5_000, retryMs = 1_000, read = path => readFile(path, "utf8"), now = Date.now }) {
  /** null: no file, check off. "": file present but bad, deny all. Otherwise the key. */
  /** @type {string | null} */
  let key = null;
  let readAt = -Infinity;
  async function load() {
    readAt = now();
    try {
      const text = (await read(file)).trim();
      key = KEY.test(text) ? text : "";
    } catch (error) {
      key = /** @type {{ code?: string }} */ (error)?.code === "ENOENT" ? null : "";
    }
  }
  /** @param {unknown} given */
  const matches = given => typeof given === "string" && !!key && timingSafeEqual(digest(given), digest(key));
  return {
    load,
    /** 8 hex characters of sha256(key), or null with no key. Emuly compares it to run setup again after a key change. */
    async fingerprint() {
      if (now() - readAt >= pollMs) await load();
      return key === null ? null : key ? digest(key).toString("hex").slice(0, 8) : "invalid";
    },
    /** True when the request may pass. `given` is the raw header value. */
    /** @param {unknown} given */
    async allows(given) {
      if (now() - readAt >= pollMs) await load();
      if (key === null) return true;
      if (matches(given)) return true;
      if (now() - readAt < retryMs) return false;
      await load();
      return key === null || matches(given);
    },
  };
}
