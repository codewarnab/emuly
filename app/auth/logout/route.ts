import { NextResponse } from "next/server";
import { env } from "../../../lib/env";
import { destroySession } from "../../../lib/auth/session";

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(env.baseUrl).origin) {
    return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  await destroySession();
  const response = NextResponse.redirect(new URL("/login", env.baseUrl), 303);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
