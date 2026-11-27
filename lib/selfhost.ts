import "server-only";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Client } from "@libsql/client";
import { env } from "./env.ts";
import { transaction } from "./data/async-database.ts";
import type { User } from "./auth/identity.ts";

/** Off by default, so every hosted path stays exactly as it is. Set EMULY_SELF_HOST=1
    (at build time too — the proxy bundle may inline env) to run one container for yourself. */
export const SELF_HOST = process.env.EMULY_SELF_HOST === "1";

type Run = (file: string, args: string[]) => Promise<string>;

/** Run a gh subcommand and return its trimmed stdout. gh errors name the fix and carry no
    credentials, so the first line is safe to surface. */
function exec(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`gh ${args[0]} failed: ${String(stderr || error.message).trim().split("\n")[0].slice(0, 200)}`));
      else resolve(stdout.trim());
    });
  });
}

/** Memoize a gh read for ttlMs, including a failed run, so one broken call cannot hammer gh.
    Concurrent callers share the in-flight read instead of racing gh. */
function memoize(run: Run, args: string[], ttlMs: number, clock: () => number): () => Promise<string> {
  let cache: { at: number } & ({ stdout: string } | { error: unknown }) | undefined;
  let pending: Promise<string> | undefined;
  return () => {
    if (pending) return pending;
    if (cache && clock() - cache.at < ttlMs) {
      if ("error" in cache) return Promise.reject(cache.error);
      return Promise.resolve(cache.stdout);
    }
    pending = run("gh", args).then(
      stdout => { cache = { stdout, at: clock() }; return stdout; },
      error => { cache = { error, at: clock() }; throw error; },
    ).finally(() => { pending = undefined; });
    return pending;
  };
}

/** gh >= 2.103 auto-refreshes an expiring token before printing it, so this needs no
    refresh logic of our own and nothing token-shaped is stored in the database. The
    timeout covers gh's cold-start network round-trips, not just the local exec.
    With a login, gh returns that account's token, not the active account's. A `gh auth switch`
    while Emuly runs then cannot give one user's calls another account's codespaces: the sync
    would read that other list and mark the user's phones deleted. */
export function createGhTokenSource(run: Run, { ttlMs = 60_000, clock = Date.now } = {}) {
  const sources = new Map<string, () => Promise<string>>();
  return (login?: string) => {
    const key = login?.toLowerCase() ?? "";
    let source = sources.get(key);
    if (!source) {
      source = memoize(run, login ? ["auth", "token", "--hostname", "github.com", "--user", login] : ["auth", "token"], ttlMs, clock);
      sources.set(key, source);
    }
    return source();
  };
}

const ghToken = createGhTokenSource((file, args) => exec(file, args, 60_000));
export { ghToken };

export type GhIdentity = { login: string; id: number; name: string | null; avatarUrl: string | null };

/** Validate the JSON shape like validateCodespace does: no unexpected response reaches the database. */
function validateIdentity(value: unknown): GhIdentity {
  const v = value as Record<string, unknown>;
  if (!v || typeof v.login !== "string" || !v.login || !Number.isSafeInteger(v.id)
    || (v.name !== null && typeof v.name !== "string")
    || (v.avatar_url !== null && typeof v.avatar_url !== "string")) {
    throw new Error("Unexpected `gh api user` response. Run `emuly doctor`.");
  }
  const { login, id, name, avatar_url: avatarUrl } = v as { login: string; id: number; name: string | null; avatar_url: string | null };
  return { login, id, name, avatarUrl };
}

const cachedIdentity = memoize((file, args) => exec(file, args, 15_000), ["api", "user"], 5 * 60_000, Date.now);
async function selfHostIdentity(): Promise<GhIdentity> {
  return validateIdentity(JSON.parse(await cachedIdentity()));
}

const userCache = new WeakMap<Client, { key: string; pending: Promise<User> }>();

/** Upsert the one self-host user from the gh identity, plus the constant "self-host"
    session row in the same transaction: the stream validators compare the sessions
    table, so that row must exist and point at this user. The token columns stay
    empty: in self-host mode github-token.ts never reads them, the token lives in
    gh's own store. */
export async function selfHostUser(database: Client, options: { identity?: GhIdentity; now?: Date } = {}): Promise<User> {
  const identity = options.identity ?? await selfHostIdentity();
  const key = JSON.stringify(identity);
  const cached = userCache.get(database);
  if (cached?.key === key) {
    const user = await cached.pending;
    // Keep local account blocking effective without writing on polling requests.
    const row = (await database.execute({ sql: "SELECT blocked FROM users WHERE id = ?", args: [user.id] })).rows[0];
    if (!row || row.blocked) throw new Error("This GitHub account is blocked in the local Emuly database. Unblock it or reset the database (see docs/SELF-HOST.md).");
    return user;
  }
  const pending = storeSelfHostUser(database, identity, options.now);
  const entry = { key, pending };
  userCache.set(database, entry);
  try { return await pending; }
  catch (error) {
    if (userCache.get(database) === entry) userCache.delete(database);
    throw error;
  }
}

async function storeSelfHostUser(database: Client, identity: GhIdentity, date?: Date): Promise<User> {
  const now = (date ?? new Date()).toISOString();
  const row = (await transaction(database, async queries => {
    const user = (await queries.execute({
      sql: `INSERT INTO users (github_id, login, name, avatar_url, token_cipher, token_scopes, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, x'', '', ?, ?)
        ON CONFLICT(github_id) DO UPDATE SET login = excluded.login, name = excluded.name,
        avatar_url = excluded.avatar_url, last_seen_at = excluded.last_seen_at
        RETURNING id, login, name, avatar_url, blocked`,
      args: [identity.id, identity.login, identity.name, identity.avatarUrl, now, now],
    })).rows[0] as unknown as { id: number; login: string; name: string | null; avatar_url: string | null; blocked: number } | undefined;
    if (!user) return undefined;
    if (user.blocked) {
      throw new Error("This GitHub account is blocked in the local Emuly database. Unblock it or reset the database (see docs/SELF-HOST.md).");
    }
    await queries.execute({
      sql: `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('self-host', ?, ?, '9999-12-31T23:59:59.999Z')
        ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at`,
      args: [user.id, now],
    });
    return user;
  }));
  if (!row) throw new Error("Could not store the self-host user. Run `emuly doctor`.");
  // Same derivation as identity.ts loadUser, so the console renders both identically.
  const initials = (row.name?.trim().split(/\s+/).map(part => Array.from(part)[0]).slice(0, 2).join("")
    || row.login.slice(0, 2)).toUpperCase();
  return { id: row.id, login: row.login, name: row.name, avatarUrl: row.avatar_url, initials, authKind: "session" };
}

/** The AES key for sealing values at rest, kept in a file next to the database so self-host
    needs no .env.local. Memoized per process so env.tokenKey does not re-read the file on
    every seal/open. First boots are serialized with a lock file and the key is published
    with an atomic rename: two processes starting together must converge on one key, and a
    concurrent reader must never see a partially written one. */
let cachedTokenKey: string | undefined;
export function selfHostTokenKey(): string {
  if (cachedTokenKey !== undefined) return cachedTokenKey;
  const file = join(dirname(env.dbPath), "token.key");
  cachedTokenKey = withFileLock(`${file}.lock`, () => {
    // Re-read under the lock: another process may have initialized or repaired the
    // file while we waited, and its key is the one every sealed value must use.
    let key = "";
    try {
      key = readFileSync(file, "utf8").trim();
    } catch (error) {
      // Only a missing file is expected; a real read failure must not be papered over.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    if (!validKey(key)) {
      // An empty or malformed file cannot decrypt anything, so regenerate: a broken
      // write must not wedge the app. (Values sealed under the old file are lost either way.)
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}`;
      writeFileSync(temp, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
      renameSync(temp, file);
      key = readFileSync(file, "utf8").trim();
    }
    // Node ignores mode for existing files, so the chmod is unconditional: a pre-existing
    // empty or malformed file may carry a wider mode that writeFileSync would keep.
    chmodSync(file, 0o600);
    return key;
  });
  return cachedTokenKey;
}

/** Runs body while holding an exclusively created lock file, retrying until it is free.
    A lock older than 10s belongs to a crashed process and is stolen. Sync sleep keeps
    initialization ordered even though callers run before any async work. */
function withFileLock<T>(lock: string, body: () => T): T {
  const stealAfter = 10_000;
  for (let waited = 0; ; waited += 50) {
    try {
      const fd = openSync(lock, "wx");
      try { return body(); } finally { closeSync(fd); unlinkSync(lock); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      let stole = false;
      try {
        if (Date.now() - statSync(lock).mtimeMs > stealAfter) { unlinkSync(lock); stole = true; }
      } catch { /* released: retry */ }
      if (stole) continue;
      if (waited >= stealAfter) throw new Error(`timed out waiting for ${lock}; another Emuly process may be stuck`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/** 32 bytes, base64-encoded exactly: the round-trip check rejects garbage Buffer.from would ignore. */
function validKey(key: string): boolean {
  if (key.length !== 44) return false;
  const bytes = Buffer.from(key, "base64");
  return bytes.length === 32 && bytes.toString("base64") === key;
}
