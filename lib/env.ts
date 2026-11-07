import "server-only";

/** Reads a required env var. Fails loudly, never prints the value. */
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}. Set it in .env.local.`);
  return v;
}

export const env = {
  get baseUrl() {
    return need("PHONELINK_BASE_URL").replace(/\/$/, "");
  },
  get clientId() {
    return need("PHONELINK_GITHUB_CLIENT_ID");
  },
  get clientSecret() {
    return need("PHONELINK_GITHUB_CLIENT_SECRET");
  },
  get tokenKey() {
    return need("PHONELINK_TOKEN_KEY");
  },
  get dbPath() {
    return process.env.PHONELINK_DB || ".data/phonelink.db";
  },
  /** Plain-HTTP LAN testing only. Must be off before any real hosting. */
  get cookieInsecure() {
    return process.env.PHONELINK_COOKIE_INSECURE === "1";
  },
};
