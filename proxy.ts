import { NextResponse, type NextRequest } from "next/server";
import { cookieName } from "./lib/auth/auth-cookies";
import { asyncDb } from "./lib/data/async-db.ts";
import { readSession } from "./lib/auth/session-store.ts";
import { env } from "./lib/env";

/** Redirect before streaming. Pages also authorize independently via requireUser(). */
export async function proxy(request: NextRequest) {
  const value = request.cookies.get(cookieName("session"))?.value;
  if (!value || !(await readSession(asyncDb(), value))) {
    const response = NextResponse.redirect(new URL("/login", env.baseUrl));
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = { matcher: "/app/:path*" };
