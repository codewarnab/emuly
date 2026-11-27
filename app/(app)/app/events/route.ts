import { getSession } from "../../../../lib/auth/session";
import { asyncDb } from "../../../../lib/data/async-db";
import { eventStream } from "../../../../lib/shared/event-stream";
import { dashboardEventReader } from "../../../../lib/phone/dashboard-events";

export const maxDuration = 300;
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return new Response(null, { status: 401 });
  // 1.5 s near a change, 4 s after 60 s with none (docs/vercel-and-response-hints-plan.md, B2).
  return eventStream(request, dashboardEventReader(asyncDb(), session), { intervalMs: 1500, quietIntervalMs: 4000, quietAfterMs: 60_000 });
}
