import { NextResponse, type NextRequest } from "next/server";
import { cookieName } from "./lib/auth/auth-cookies";
import { asyncDb } from "./lib/data/async-db.ts";
import { readSession } from "./lib/auth/session-store.ts";
import { env } from "./lib/env";
import { SELF_HOST } from "./lib/selfhost";

/** Redirect before streaming. Pages also authorize independently via requireUser(). */
export async function proxy(request: NextRequest) {
  // Self-host has no session cookie. The one identity is resolved per request, so only
  // the private, no-store caching still applies.
  if (SELF_HOST) {
    const response = NextResponse.next();
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
  const value = request.cookies.get(cookieName("session"))?.value;
  if (!value || !(await readSession(asyncDb(), value))) {
    const login = new URL("/login", env.baseUrl);
    login.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    const response = NextResponse.redirect(login);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = { matcher: "/app/:path*" };
