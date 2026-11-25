import { getSession } from "../../../../../lib/auth/session";
import { asyncDb } from "../../../../../lib/data/async-db";
import { findPhone } from "../../../../../lib/phone/phones";
import { runnerApps } from "../../../../../lib/phone/phone-runner";
import { parseAppInstalls, readPhoneResponse } from "../../../../../lib/phone/phone-response";
import { eventStream } from "../../../../../lib/shared/event-stream";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

export const maxDuration = 300;
async function handleGET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return new Response(null, { status: 401 });
  const { id } = await context.params;
  const phone = await findPhone(session.userId, id);
  if (!phone) return new Response(null, { status: 404 });
  return eventStream(request, async () => {
    const valid = (await asyncDb().execute({ sql: `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND u.blocked = 0 AND s.expires_at > ?`, args: [session.id, new Date().toISOString()] })).rows.length;
    if (!valid) return undefined;
    const current = await findPhone(session.userId, id);
    if (!current || current.state !== "running" || current.android_state !== "ready") return undefined;
    const response = await runnerApps(session.userId, id, "/app-installs", { method: "GET", signal: request.signal });
    if (!response.ok) return undefined;
    return readPhoneResponse(response, parseAppInstalls);
  });
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const GET = withApiUsage(handleGET);
