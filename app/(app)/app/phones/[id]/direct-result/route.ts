import { NO_STORE } from "../../../../../../lib/http";
import { getUser } from "../../../../../../lib/auth/auth";
import { findPhone } from "../../../../../../lib/phone/phones";
import { asyncDb } from "../../../../../../lib/data/async-db";
import { recordDirectResult } from "../../../../../../lib/phone/network-hint";

/** The browser reports whether the direct video path opened. Body: {"blocked": true|false}. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const response = (status: number) => new Response(null, { status, headers: { "Cache-Control": NO_STORE } });
  if (request.headers.get("origin") !== new URL(request.url).origin) return response(403);
  const user = await getUser();
  if (!user) return response(401);
  if (!await findPhone(user.id, (await context.params).id)) return response(404);
  const body = await request.json().catch(() => null) as { blocked?: unknown } | null;
  if (!body || typeof body.blocked !== "boolean" || Object.keys(body).length !== 1) return response(400);
  await recordDirectResult(asyncDb(), user.id, body.blocked);
  return response(204);
}
