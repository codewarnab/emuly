import "server-only";
import { db } from "./db.ts";
import { open, seal } from "./crypto.ts";
import { exchangeTokens } from "./github-oauth.ts";

type TokenRow = {
  token_cipher: Uint8Array;
  token_expires_at: string | null;
  refresh_cipher: Uint8Array | null;
  refresh_expires_at: string | null;
};

// All callers for one user share the same refresh, including rotated refresh tokens.
const refreshing = new Map<number, Promise<string>>();

export async function getAccessToken(userId: number): Promise<string> {
  const pending = refreshing.get(userId);
  if (pending) return pending;
  const row = db().prepare(`SELECT token_cipher, token_expires_at, refresh_cipher,
    refresh_expires_at FROM users WHERE id = ? AND blocked = 0`).get(userId) as TokenRow | undefined;
  if (!row) throw new Error("Sign in again");
  if (row.token_expires_at && Date.parse(row.token_expires_at) > Date.now() + 5 * 60_000) {
    return open(row.token_cipher);
  }
  const promise = refresh(userId, row);
  refreshing.set(userId, promise);
  try { return await promise; }
  finally { refreshing.delete(userId); }
}

async function refresh(userId: number, row: TokenRow): Promise<string> {
  try {
    if (!row.refresh_cipher || !row.refresh_expires_at
      || !(Date.parse(row.refresh_expires_at) > Date.now())) throw new Error("Refresh expired");
    const pair = await exchangeTokens({
      grant_type: "refresh_token",
      refresh_token: open(row.refresh_cipher),
    });
    db().prepare(`UPDATE users SET token_cipher = ?, token_expires_at = ?, refresh_cipher = ?,
      refresh_expires_at = ?, token_scopes = ? WHERE id = ?`).run(
      seal(pair.accessToken), pair.accessExpiresAt, seal(pair.refreshToken), pair.refreshExpiresAt, pair.scopes, userId,
    );
    return pair.accessToken;
  } catch {
    // Never propagate upstream errors: they may contain credentials or response bodies.
    db().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    throw new Error("Sign in again");
  }
}
