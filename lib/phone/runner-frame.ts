import { asyncDb } from "../data/async-db.ts";
import { runnerRequest } from "./phone-runner.ts";

export async function runnerFrame(userId: number, phoneId: string, sessionId: string) {
  const valid = (await asyncDb().execute({ sql: `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
    JOIN phones p ON p.user_id = u.id WHERE s.id = ? AND u.id = ? AND u.blocked = 0 AND s.expires_at > ?
    AND p.id = ? AND p.state = 'running' AND p.android_state = 'ready'`, args: [sessionId, userId, new Date().toISOString(), phoneId] })).rows.length;
  if (!valid) return new Response(null, { status: 403 });
  return runnerRequest(userId, phoneId, "/screenshot");
}
