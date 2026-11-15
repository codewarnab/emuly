/** Self-host bypasses login and must never be bundled or started as a public deployment. */
/** @param {Record<string, string | undefined>} env */
export function assertSelfHostEnvironment(env = process.env) {
  if (env.EMULY_SELF_HOST !== "1") return;
  const base = env.EMULY_BASE_URL ? new URL(env.EMULY_BASE_URL) : null;
  const local = base && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (env.VERCEL || (env.NODE_ENV === "production" && base?.protocol === "https:" && !local)) {
    throw new Error("EMULY_SELF_HOST=1 cannot be used on Vercel or with a public production HTTPS base URL.");
  }
}
