import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { randomId } from "../../../lib/auth/crypto";
import { env } from "../../../lib/env";
import { cookieName, cookieOptions } from "../../../lib/auth/auth-cookies";

export async function GET(request: NextRequest) {
  const store = await cookies();
  const state = randomId();
  store.set(cookieName("state"), state, cookieOptions(10 * 60));
  const billing = request.nextUrl.searchParams.get("billing") === "1";
  store.set(cookieName("billing"), billing ? "1" : "", cookieOptions(billing ? 10 * 60 : 0));
  // Login asks for `codespace` only. That scope cannot read GitHub's billing usage, so the
  // quota strip counts only Emuly phone runs (see docs/BILLING-USAGE.md). `?billing=1` adds `user`,
  // but no UI links to it (decided 2026-11-09: `user` is too broad and is not confirmed to work).
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: `${env.baseUrl}/auth/callback`,
    scope: billing ? "codespace user" : "codespace",
    state,
    allow_signup: "true",
  }).toString();
  const response = NextResponse.redirect(url, 302);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
