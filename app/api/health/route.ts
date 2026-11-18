import { asyncDb } from "../../../lib/data/async-db";
import { schedulerHealth } from "../../../lib/phone/scheduler-health";

/** Public liveness check. Returns 503 when the scheduler (the VM cron on /api/cron) has not run for 5 minutes. */
export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    const { late, started_at } = await schedulerHealth(asyncDb(), "reconcile");
    return Response.json({ ok: !late, scheduler: { late, last_run_at: started_at && new Date(started_at).toISOString() } },
      { status: late ? 503 : 200, headers });
  } catch {
    return Response.json({ ok: false, database: "unavailable" }, { status: 503, headers });
  }
}
