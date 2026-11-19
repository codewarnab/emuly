import { NextResponse } from "next/server";
import { env } from "../../../lib/env";
import { waitUntil } from "@vercel/functions";
import { destroySession, getSession } from "../../../lib/auth/session";
import { revokeDirect } from "../../../lib/phone/phone-runner";
import { SELF_HOST } from "../../../lib/selfhost";

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(env.baseUrl).origin) {
    return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const session = await getSession();
  await destroySession();
  // Close this user's direct streams. It runs after the answer, so logout stays fast.
  if (session) waitUntil(revokeDirect(session.userId).catch(() => {}));
  // Self-host has one always-authenticated user: /login would bounce straight back to /app.
  const response = NextResponse.redirect(new URL(SELF_HOST ? "/app" : "/login", env.baseUrl), 303);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
