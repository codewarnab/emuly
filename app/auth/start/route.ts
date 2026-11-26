import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { randomId } from "../../../lib/auth/crypto";
import { env } from "../../../lib/env";
import { cookieName, cookieOptions } from "../../../lib/auth/auth-cookies";
import { safeNext } from "../../../lib/auth/next-path";

export async function GET(request: NextRequest) {
  const store = await cookies();
  const state = randomId();
  store.set(cookieName("state"), state, cookieOptions(10 * 60));
  const next = safeNext(request.nextUrl.searchParams.get("next"));
  store.set(cookieName("next"), next ?? "", cookieOptions(next ? 10 * 60 : 0));
  // Login asks for `codespace` only, with no way to add more. That scope cannot read GitHub's billing
  // usage, so the quota strip counts only Emuly phone runs (see docs/BILLING-USAGE.md).
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: `${env.baseUrl}/auth/callback`,
    scope: "codespace",
    state,
    allow_signup: "true",
    // "Not you?" on the login page: let the user pick another GitHub account.
    ...(request.nextUrl.searchParams.get("switch") === "1" ? { prompt: "select_account" } : {}),
  }).toString();
  const response = NextResponse.redirect(url, 302);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
