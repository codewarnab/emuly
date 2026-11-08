import { getSession } from "../../../../lib/auth/session";
import { asyncDb } from "../../../../lib/data/async-db";
import { eventStream } from "../../../../lib/shared/event-stream";
import { listPhones } from "../../../../lib/phone/phones";

export const maxDuration = 300;
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return new Response(null, { status: 401 });
  return eventStream(request, async () => {
    const database = asyncDb();
    const valid = (await database.execute({ sql: `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND u.blocked = 0 AND s.expires_at > ?`, args: [session.id, new Date().toISOString()] })).rows.length;
    if (!valid) return undefined;
    const phones = await listPhones(session.userId);
    const events = (await database.execute({ sql: "SELECT max(id) AS id, count(*) AS count FROM events WHERE user_id = ?", args: [session.userId] })).rows;
    return { phones, events };
  });
}
