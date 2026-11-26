import { createHash } from "node:crypto";

/**
 * Retry key for /adb: a call with the same Idempotency-Key and the same adb arguments in the last
 * 10 minutes does not run again. It gets the first call's result (or error), with "replayed": true.
 * So a retry of a `tap` whose reply was lost cannot tap twice.
 * - The key counts only with the same arguments, so a reused key with another command runs it.
 * - File and screenshot bytes are not kept after the call ends. A read does not change the phone,
 *   so a later retry of it runs again.
 */
export function createAdbReplay({ ttlMs = 10 * 60_000, max = 200, now = Date.now } = {}) {
  /** @type {Map<string, { at: number, promise: Promise<any> }>} */
  const entries = new Map();
  return {
    get size() { return entries.size; },
    /** @param {string} key @param {string[]} args @param {() => Promise<any>} work */
    async run(key, args, work) {
      for (const [old, entry] of entries) if (now() - entry.at > ttlMs) entries.delete(old);
      const id = `${key}\n${createHash("sha256").update(JSON.stringify(args)).digest("base64url")}`;
      const seen = entries.get(id);
      if (seen) {
        try {
          const result = await seen.promise;
          return result?.file || result?.png ? result : { ...result, replayed: true };
        } catch (error) { error.replayed = true; throw error; }
      }
      const promise = work();
      promise.catch(() => {});
      entries.set(id, { at: now(), promise });
      while (entries.size > max) entries.delete(entries.keys().next().value);
      try {
        const result = await promise;
        if (result?.file || result?.png) entries.delete(id);
        return result;
      } catch (error) {
        // Nothing ran: a retry with the same key may run it.
        if (error?.ran === false) entries.delete(id);
        throw error;
      }
    },
  };
}
