import type { Client } from "@libsql/client";

/**
 * Some networks refuse DNS for *.app.github.dev (we saw "Query refused" on a Reliance Jio connection).
 * Then the fast direct video path cannot open, and video goes through Emuly's server instead.
 * The browser detects this and tells the server; the agent API then shows `network_hint`.
 * The text is plain and short, so an agent can repeat it to the user as is.
 */
export const DIRECT_BLOCKED_HINT = {
  code: "direct_port_blocked",
  message: "Your network seems to block app.github.dev. Some internet providers refuse this name in DNS. "
    + "So the fast direct video path cannot open. Video still works through Emuly's server, but it can be a little slower.",
  fix: [
    "Set your computer's DNS to 1.1.1.1 (Cloudflare) or 8.8.8.8 (Google).",
    "Or turn on Secure DNS in your browser settings.",
    "Or use another network, for example Wi-Fi in place of a mobile hotspot.",
  ],
  sources: [
    { title: "GitHub: port forwarding in Codespaces does not work", url: "https://docs.github.com/en/codespaces/troubleshooting/troubleshooting-port-forwarding-for-github-codespaces" },
    { title: "Cloudflare: set up 1.1.1.1", url: "https://developers.cloudflare.com/1.1.1.1/setup/" },
    { title: "Google: use Public DNS 8.8.8.8", url: "https://developers.google.com/speed/public-dns/docs/using" },
  ],
} as const;

/** A report older than this is old news: the user may have changed network or DNS. */
const HINT_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** blocked=false (the direct path opened) clears an earlier report. */
export async function recordDirectResult(database: Client, userId: number, blocked: boolean, now = Date.now()) {
  await database.execute(blocked
    ? { sql: `INSERT INTO user_network (user_id, direct_blocked_at) VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET direct_blocked_at = excluded.direct_blocked_at`, args: [userId, now] }
    : { sql: "DELETE FROM user_network WHERE user_id = ?", args: [userId] });
}

export async function directBlocked(database: Client, userId: number, now = Date.now()) {
  const row = (await database.execute({ sql: "SELECT direct_blocked_at FROM user_network WHERE user_id = ?", args: [userId] })).rows[0];
  const at = Number(row?.direct_blocked_at ?? 0);
  return at > 0 && now - at < HINT_TTL_MS;
}
