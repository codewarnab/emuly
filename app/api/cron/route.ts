import { timingSafeEqual } from "node:crypto";
import { reconcile } from "../../../lib/phone/reconcile";
import { CoordinationBusyError } from "../../../lib/data/coordination";

export const maxDuration = 300;
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  if (!secret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return new Response(null, { status: 401 });
  }
  try {
    await reconcile();
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ ok: false, busy: error instanceof CoordinationBusyError },
      { status: error instanceof CoordinationBusyError ? 409 : 503, headers: { "Cache-Control": "no-store" } });
  }
}
