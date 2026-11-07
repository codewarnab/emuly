import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { randomId } from "../../../lib/crypto";
import { env } from "../../../lib/env";
import { cookieName, cookieOptions } from "../../../lib/auth-cookies";

export async function GET() {
  const store = await cookies();
  const state = randomId();
  store.set(cookieName("state"), state, cookieOptions(10 * 60));
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: `${env.baseUrl}/auth/callback`,
    scope: "codespace",
    state,
    allow_signup: "true",
  }).toString();
  const response = NextResponse.redirect(url, 302);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
