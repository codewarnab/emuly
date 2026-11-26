import { NextResponse, type NextRequest } from "next/server";
import { cookieName, SIGNED_IN_HINT, hintCookieOptions } from "./lib/auth/auth-cookies";
import { SESSION_MAX_AGE } from "./lib/auth/session-store.ts";
import { sessionCookieShape } from "./lib/auth/session-store.ts";
import { env } from "./lib/env";
import { SELF_HOST } from "./lib/selfhost";

/** Redirect before streaming when there is no session cookie. The proxy reads no database:
    each page (requireUser in the (app) layout) and each route checks the session itself. */
export async function proxy(request: NextRequest) {
  // Self-host has no session cookie. The one identity is resolved per request, so only
  // the private, no-store caching still applies.
  if (SELF_HOST) {
    const response = NextResponse.next();
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
  const value = request.cookies.get(cookieName("session"))?.value;
  if (!sessionCookieShape(value)) {
    const login = new URL("/login", env.baseUrl);
    login.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    const response = NextResponse.redirect(login);
    response.headers.set("Cache-Control", "no-store");
    if (request.cookies.has(SIGNED_IN_HINT)) response.cookies.set(SIGNED_IN_HINT, "", hintCookieOptions(0));
    return response;
  }
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  // Sessions made before the hint existed get it on their next console visit.
  if (!request.cookies.has(SIGNED_IN_HINT)) response.cookies.set(SIGNED_IN_HINT, "1", hintCookieOptions(SESSION_MAX_AGE));
  return response;
}

export const config = { matcher: "/app/:path*" };
