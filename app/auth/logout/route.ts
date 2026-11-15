import { NextResponse } from "next/server";
import { env } from "../../../lib/env";
import { destroySession } from "../../../lib/auth/session";
import { SELF_HOST } from "../../../lib/selfhost";

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(env.baseUrl).origin) {
    return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  await destroySession();
  // Self-host has one always-authenticated user: /login would bounce straight back to /app.
  const response = NextResponse.redirect(new URL(SELF_HOST ? "/app" : "/login", env.baseUrl), 303);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
