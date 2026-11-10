import { getSession } from "../../../../../../lib/auth/session";
import { asyncDb } from "../../../../../../lib/data/async-db";
import { findPhone } from "../../../../../../lib/phone/phones";
import { latestEventId, readAgentActions } from "../../../../../../lib/phone/agent-actions-feed";
import { parseWmSize } from "../../../../../../lib/phone/agent-action";
import { runnerAdb } from "../../../../../../lib/phone/phone-runner";
import { adbResult } from "../../../../../../lib/phone/phone-adb-contract";
import { eventStream } from "../../../../../../lib/shared/event-stream";

export const maxDuration = 300;

/** The phone's real display size, so the client can map adb coordinates onto it. */
async function readDisplay(userId: number, id: string): Promise<{ width: number; height: number } | null> {
  try {
    const response = await runnerAdb(userId, id, { args: ["shell", "wm", "size"], timeout_s: 10 });
    const result = adbResult(await response.json() as unknown);
    return result.exit_code === 0 ? parseWmSize(result.stdout) : null;
  } catch {
    // A missing or unhappy runner must not stop the action stream.
    return null;
  }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return new Response(null, { status: 401 });
  const { id } = await context.params;
  const phone = await findPhone(session.userId, id);
  if (!phone) return new Response(null, { status: 404 });
  // Read once per stream: rotation is out of scope and wm size is not an agent action.
  const display = await readDisplay(session.userId, id);
  let after = await latestEventId(session.userId, id);
  return eventStream(request, async () => {
    const valid = (await asyncDb().execute({ sql: `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND u.blocked = 0 AND s.expires_at > ?`, args: [session.id, new Date().toISOString()] })).rows.length;
    if (!valid) return undefined;
    const actions = await readAgentActions(session.userId, id, after);
    if (actions.length > 0) after = actions[actions.length - 1].id;
    return { display, actions };
  }, { intervalMs: 400 });
}
