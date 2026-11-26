import "server-only";
import { withLease } from "../data/coordination.ts";
import { asyncDb } from "../data/async-db.ts";
import { transaction } from "../data/async-database.ts";
import type { Client } from "@libsql/client";
import { open, seal, contexts } from "../auth/crypto.ts";
import { exchangeTokens, SignInError } from "../auth/github-oauth.ts";
import { SELF_HOST, ghToken } from "../selfhost.ts";

/** GitHub or the database did not answer during a token refresh. The sessions stay; try again later. */
export class TokenUnavailableError extends Error {
  constructor() { super("GitHub is not available. Try again."); this.name = "TokenUnavailableError"; }
}

type TokenRow = {
  github_id: number;
  token_cipher: Uint8Array;
  token_expires_at: string | null;
  refresh_cipher: Uint8Array | null;
  refresh_expires_at: string | null;
};
type Options = { clock?: () => number; fetch?: typeof fetch };

export function createAccessTokenProvider({ database, encrypt = seal, decrypt = open }: {
  database: Client;
  encrypt?: (value: string, context: string) => Uint8Array;
  decrypt?: (value: Uint8Array, context: string) => string;
}) {
  // Register before the first database await so callers share rotated refresh tokens.
  const refreshing = new Map<number, Promise<string>>();
  async function readToken(userId: number) {
    const row = (await database.execute({ sql: `SELECT github_id, token_cipher, token_expires_at, refresh_cipher,
      refresh_expires_at FROM users WHERE id = ? AND blocked = 0`, args: [userId] })).rows[0] as unknown as TokenRow | undefined;
    if (!row) throw new Error("Sign in again");
    return row;
  }
  function fresh(row: TokenRow, options: Options) {
    const clock = options.clock ?? Date.now;
    return Boolean(row.token_expires_at && Date.parse(row.token_expires_at) > clock() + 5 * 60_000);
  }
  async function resolve(userId: number, options: Options): Promise<string> {
    const row = await readToken(userId);
    const clock = options.clock ?? Date.now;
    if (fresh(row, options)) return decrypt(row.token_cipher, contexts.githubAccess(row.github_id));
    // True while the database saves the new pair. An error there is short, like a GitHub outage.
    let saving = false;
    try {
      if (!row.refresh_cipher || !row.refresh_expires_at
        || !(Date.parse(row.refresh_expires_at) > clock())) throw new Error("Refresh expired");
      const pair = await exchangeTokens({ grant_type: "refresh_token", refresh_token: decrypt(row.refresh_cipher, contexts.githubRefresh(row.github_id)) }, { ...options, clock });
      saving = true;
      const result = await transaction(database, queries => queries.execute({ sql: `UPDATE users SET token_cipher = ?, token_expires_at = ?, refresh_cipher = ?,
        refresh_expires_at = ?, token_scopes = ? WHERE id = ? AND blocked = 0 AND refresh_cipher = ?`,
        args: [encrypt(pair.accessToken, contexts.githubAccess(row.github_id)), pair.accessExpiresAt,
          encrypt(pair.refreshToken, contexts.githubRefresh(row.github_id)), pair.refreshExpiresAt, pair.scopes, userId, row.refresh_cipher] }));
      saving = false;
      if (!result.rowsAffected) throw new Error("Sign in again");
      return pair.accessToken;
    } catch (error) {
      // Only a refresh that GitHub rejected ends the sessions. A timeout, a GitHub 5xx or 429, or a
      // database error is short: the sessions stay and the next request tries again.
      if (saving || (error instanceof SignInError && error.code === "unavailable")) throw new TokenUnavailableError();
      // Never propagate upstream errors: they may contain credentials or response bodies.
      // A stale refresher must not invalidate sessions after another instance rotates tokens.
      await transaction(database, queries => queries.execute({ sql: `DELETE FROM sessions WHERE user_id = ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND refresh_cipher IS ?)`,
        args: [userId, userId, row.refresh_cipher] }));
      throw new Error("Sign in again");
    }
  }
  return async function accessToken(userId: number, options: Options = {}): Promise<string> {
    const pending = refreshing.get(userId);
    if (pending) return pending;
    // Fast path: a valid token needs one read and no lease. Only a refresh rotates the
    // refresh token, so only a refresh needs the lease (resolve reads the row again under it).
    const row = await readToken(userId);
    if (fresh(row, options)) return decrypt(row.token_cipher, contexts.githubAccess(row.github_id));
    const again = refreshing.get(userId);
    if (again) return again;
    const promise = withLease(database, `oauth:${userId}`, () => resolve(userId, options), 20_000);
    refreshing.set(userId, promise);
    try { return await promise; }
    finally { refreshing.delete(userId); }
  };
}

const providers = new WeakMap<Client, ReturnType<typeof createAccessTokenProvider>>();
export function getAccessToken(userId: number, options: Options = {}): Promise<string> {
  // Self-host: the token lives in gh's own store and gh auto-refreshes it before printing.
  // There is one user, so the userId is ignored; this also covers billingClient.
  if (SELF_HOST) return ghToken();
  const database = asyncDb();
  let provider = providers.get(database);
  if (!provider) { provider = createAccessTokenProvider({ database }); providers.set(database, provider); }
  return provider(userId, options);
}
