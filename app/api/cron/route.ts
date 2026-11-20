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
  // The VM scheduler (scripts/scheduler.ts) does this work now. EMULY_CRON_OFF=1 turns this fallback off.
  // With it on, the shared lease makes this answer 409 while the scheduler runs.
  if (process.env.EMULY_CRON_OFF === "1") return Response.json({ ok: true, off: true }, { headers: { "Cache-Control": "no-store" } });
  try {
    await reconcile();
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ ok: false, busy: error instanceof CoordinationBusyError },
      { status: error instanceof CoordinationBusyError ? 409 : 503, headers: { "Cache-Control": "no-store" } });
  }
}
