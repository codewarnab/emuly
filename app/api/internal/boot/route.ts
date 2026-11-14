import { timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { phoneControl } from "../../../../lib/phone/phone-control";
import { PHONE_ID } from "../../../../lib/shared/phone-name";

// A boot gets this request's full time budget. Typical boots take 60-130 s.
export const maxDuration = 300;

/** Internal: boots Android for one phone. Only the server itself calls this, with CRON_SECRET. */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  if (!secret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return new Response(null, { status: 401 });
  }
  let body: { userId?: unknown; id?: unknown };
  try { body = await request.json(); } catch { return new Response(null, { status: 400 }); }
  if (!Number.isSafeInteger(body.userId) || typeof body.id !== "string" || !PHONE_ID.test(body.id)) {
    return new Response(null, { status: 400 });
  }
  const userId = Number(body.userId), id = body.id;
  waitUntil(phoneControl().bootNow(userId, id).catch(error => {
    console.error(`[boot] ${id}: boot request failed`, error instanceof Error ? error.name : "unknown");
  }));
  return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
}
