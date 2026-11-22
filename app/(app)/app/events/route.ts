import { getSession } from "../../../../lib/auth/session";
import { asyncDb } from "../../../../lib/data/async-db";
import { eventStream } from "../../../../lib/shared/event-stream";
import { dashboardEventReader } from "../../../../lib/phone/dashboard-events";

export const maxDuration = 300;
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return new Response(null, { status: 401 });
  return eventStream(request, dashboardEventReader(asyncDb(), session));
}
