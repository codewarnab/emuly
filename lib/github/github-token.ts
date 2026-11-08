import "server-only";
import { asyncDb } from "../data/async-db.ts";
import type { DatabaseQueries } from "../data/async-database.ts";
import { open, seal } from "../auth/crypto.ts";
import { exchangeTokens } from "../auth/github-oauth.ts";

type TokenRow = {
  token_cipher: Uint8Array;
  token_expires_at: string | null;
  refresh_cipher: Uint8Array | null;
  refresh_expires_at: string | null;
};
type Options = { clock?: () => number; fetch?: typeof fetch };

export function createAccessTokenProvider({ database, encrypt = seal, decrypt = open }: {
  database: DatabaseQueries;
  encrypt?: (value: string) => Uint8Array;
  decrypt?: (value: Uint8Array) => string;
}) {
  // Register before the first database await so callers share rotated refresh tokens.
  const refreshing = new Map<number, Promise<string>>();
  async function resolve(userId: number, options: Options): Promise<string> {
    const row = (await database.execute({ sql: `SELECT token_cipher, token_expires_at, refresh_cipher,
      refresh_expires_at FROM users WHERE id = ? AND blocked = 0`, args: [userId] })).rows[0] as unknown as TokenRow | undefined;
    if (!row) throw new Error("Sign in again");
    const clock = options.clock ?? Date.now;
    if (row.token_expires_at && Date.parse(row.token_expires_at) > clock() + 5 * 60_000) {
      return decrypt(row.token_cipher);
    }
    try {
      if (!row.refresh_cipher || !row.refresh_expires_at
        || !(Date.parse(row.refresh_expires_at) > clock())) throw new Error("Refresh expired");
      const pair = await exchangeTokens({ grant_type: "refresh_token", refresh_token: decrypt(row.refresh_cipher) }, { ...options, clock });
      const result = await database.execute({ sql: `UPDATE users SET token_cipher = ?, token_expires_at = ?, refresh_cipher = ?,
        refresh_expires_at = ?, token_scopes = ? WHERE id = ? AND blocked = 0`,
        args: [encrypt(pair.accessToken), pair.accessExpiresAt, encrypt(pair.refreshToken), pair.refreshExpiresAt, pair.scopes, userId] });
      if (!result.rowsAffected) throw new Error("Sign in again");
      return pair.accessToken;
    } catch {
      // Never propagate upstream errors: they may contain credentials or response bodies.
      await database.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [userId] });
      throw new Error("Sign in again");
    }
  }
  return async function accessToken(userId: number, options: Options = {}): Promise<string> {
    const pending = refreshing.get(userId);
    if (pending) return pending;
    const promise = resolve(userId, options);
    refreshing.set(userId, promise);
    try { return await promise; }
    finally { refreshing.delete(userId); }
  };
}

const providers = new WeakMap<DatabaseQueries, ReturnType<typeof createAccessTokenProvider>>();
export function getAccessToken(userId: number, options: Options = {}): Promise<string> {
  const database = asyncDb();
  let provider = providers.get(database);
  if (!provider) { provider = createAccessTokenProvider({ database }); providers.set(database, provider); }
  return provider(userId, options);
}
