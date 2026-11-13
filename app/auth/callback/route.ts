import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "../../../lib/env";
import { asyncDb } from "../../../lib/data/async-db.ts";
import { seal, contexts } from "../../../lib/auth/crypto";
import { createSession } from "../../../lib/auth/session";
import { cookieName, cookieOptions } from "../../../lib/auth/auth-cookies";
import { exchangeTokens, githubIdentity, githubGet, SignInError } from "../../../lib/auth/github-oauth";
import { getUser } from "../../../lib/auth/auth";
import { safeNext } from "../../../lib/auth/next-path";
import { billingClient } from "../../../lib/github/billing";

export async function GET(request: NextRequest) {
  const store = await cookies();
  const expected = store.get(cookieName("state"))?.value;
  const billing = store.get(cookieName("billing"))?.value === "1";
  const next = safeNext(store.get(cookieName("next"))?.value);
  store.set(cookieName("billing"), "", cookieOptions(0));
  store.set(cookieName("next"), "", cookieOptions(0));
  const current = billing ? await getUser() : null;
  const failurePath = current ? "/app?billing=unavailable" : loginFailure("denied", next);
  // Clear on every result, including denial and malformed requests.
  store.set(cookieName("state"), "", cookieOptions(0));
  const state = request.nextUrl.searchParams.get("state");
  if (!validState(state, expected)) return result(loginFailure("state", next));
  if (request.nextUrl.searchParams.has("error")) return result(failurePath);
  const code = request.nextUrl.searchParams.get("code");
  if (!code || code.length > 1024) return result(loginFailure("code", next));
  try {
    const pair = await exchangeTokens({ code, redirect_uri: `${env.baseUrl}/auth/callback` });
    const identity = await githubIdentity(pair.accessToken);
    if (current) {
      const existing = (await asyncDb().execute({ sql: "SELECT github_id FROM users WHERE id = ?", args: [current.id] })).rows[0];
      if (existing?.github_id !== identity.githubId) return result(failurePath);
    }
    const probe = await githubGet("/user/codespaces?per_page=1", pair.accessToken);
    if (probe.status !== 200) throw new SignInError("probe");
    await probe.body?.cancel();
    const timestamp = new Date().toISOString();
    const user = (await asyncDb().execute({ sql: `INSERT INTO users (github_id, login, name, avatar_url,
      token_cipher, token_expires_at, refresh_cipher, refresh_expires_at, token_scopes, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(github_id) DO UPDATE SET login=excluded.login, name=excluded.name,
      avatar_url=excluded.avatar_url, token_cipher=excluded.token_cipher,
      token_expires_at=excluded.token_expires_at, refresh_cipher=excluded.refresh_cipher,
      refresh_expires_at=excluded.refresh_expires_at, token_scopes=excluded.token_scopes,
      last_seen_at=excluded.last_seen_at RETURNING id, blocked`, args: [
      identity.githubId, identity.login, identity.name, identity.avatarUrl,
      seal(pair.accessToken, contexts.githubAccess(identity.githubId)), pair.accessExpiresAt,
      seal(pair.refreshToken, contexts.githubRefresh(identity.githubId)), pair.refreshExpiresAt,
      pair.scopes, timestamp, timestamp,
    ] })).rows[0] as unknown as { id: number; blocked: number };
    if (user.blocked) return result(loginFailure("blocked", next));
    billingClient.invalidate(user.id);
    await createSession(user.id);
    return result(next ?? "/app");
  } catch (error) {
    // Do not log the request, provider payload, authorization code, or exception.
    return result(current ? failurePath : loginFailure(error instanceof SignInError ? error.code : "signin", next));
  }
}

function loginFailure(code: string, next: string | null) {
  return `/login?error=${code}${next ? `&next=${encodeURIComponent(next)}` : ""}`;
}

function validState(state: string | null, expected: string | undefined) {
  if (!state || !expected || !/^[A-Za-z0-9_-]{43}$/.test(state)) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(state), digest(expected));
}

function result(path: string) {
  const response = NextResponse.redirect(new URL(path, env.baseUrl), 302);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
