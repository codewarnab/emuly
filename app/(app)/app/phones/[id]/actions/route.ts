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
    const actions = await readAgentActions(asyncDb(), session, id, after);
    if (!actions) return undefined;
    if (actions.length > 0) after = actions[actions.length - 1].id;
    return { display, actions };
  // 400 ms while an agent acts, 1.5 s after 30 s with no action (docs/vercel-and-response-hints-plan.md, B2).
  }, { intervalMs: 400, quietIntervalMs: 1500, quietAfterMs: 30_000 });
}
