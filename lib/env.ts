import "server-only";

/** Reads a required env var. Fails loudly, never prints the value. */
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}. Set it in .env.local.`);
  return v;
}

export const env = {
  get baseUrl() {
    return need("EMULY_BASE_URL").replace(/\/$/, "");
  },
  get clientId() {
    return need("EMULY_GITHUB_CLIENT_ID");
  },
  get clientSecret() {
    return need("EMULY_GITHUB_CLIENT_SECRET");
  },
  get tokenKey() {
    return need("EMULY_TOKEN_KEY");
  },
  /** Current key first. EMULY_TOKEN_KEY_OLD is read only during a rotation. */
  get tokenKeys(): string[] {
    const old = process.env.EMULY_TOKEN_KEY_OLD;
    return old ? [need("EMULY_TOKEN_KEY"), old] : [need("EMULY_TOKEN_KEY")];
  },
  get dbPath() {
    return process.env.EMULY_DB || ".data/emuly.db";
  },
  /** Plain-HTTP LAN testing only. Must be off before any real hosting. */
  get cookieInsecure() {
    return process.env.EMULY_COOKIE_INSECURE === "1";
  },
};
