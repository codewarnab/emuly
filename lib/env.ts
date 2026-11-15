import "server-only";
import { SELF_HOST, selfHostTokenKey } from "./selfhost.ts";

/** Reads a required env var. Fails loudly, never prints the value. */
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}. Set it in .env.local.`);
  return v;
}

export const env = {
  get baseUrl() {
    // Self-host runs on one loopback port, so the OAuth-only EMULY_BASE_URL can stay unset.
    // The default must track PORT, or a remapped port makes every origin check fail.
    if (SELF_HOST && !process.env.EMULY_BASE_URL) return `http://localhost:${process.env.PORT ?? 4321}`;
    return need("EMULY_BASE_URL").replace(/\/$/, "");
  },
  get clientId() {
    return need("EMULY_GITHUB_CLIENT_ID");
  },
  get clientSecret() {
    return need("EMULY_GITHUB_CLIENT_SECRET");
  },
  get tokenKey() {
    // Self-host keeps the key in a file next to the database; no .env.local needed.
    return process.env.EMULY_TOKEN_KEY || (SELF_HOST ? selfHostTokenKey() : need("EMULY_TOKEN_KEY"));
  },
  /** Current key first. EMULY_TOKEN_KEY_OLD is read only during a rotation. */
  get tokenKeys(): string[] {
    const old = process.env.EMULY_TOKEN_KEY_OLD;
    const current = process.env.EMULY_TOKEN_KEY || (SELF_HOST ? selfHostTokenKey() : need("EMULY_TOKEN_KEY"));
    return old ? [current, old] : [current];
  },
  get dbPath() {
    return process.env.EMULY_DB || ".data/emuly.db";
  },
  /** Plain-HTTP LAN testing only. Must be off before any real hosting. */
  get cookieInsecure() {
    return process.env.EMULY_COOKIE_INSECURE === "1";
  },
};
