import type { Session } from "../auth/session-store.ts";
import type { DatabaseQueries } from "../data/async-database.ts";
import { HEARTBEAT } from "../shared/event-stream.ts";
import { listPhones } from "./phones.ts";
import { readSyncError } from "./sync-gate.ts";

export function dashboardEventReader(database: DatabaseQueries, session: Session) {
  let previousVersion: unknown;
  return async () => {
    const authorized = (await database.execute({
      sql: `SELECT COALESCE(c.version, 0) AS version FROM sessions s
        JOIN users u ON u.id = s.user_id LEFT JOIN user_changes c ON c.user_id = s.user_id
        WHERE s.id = ? AND s.user_id = ? AND u.blocked = 0 AND s.expires_at > ?`,
      args: [session.id, session.userId, new Date().toISOString()],
    })).rows[0];
    if (!authorized) return undefined;
    if (authorized.version === previousVersion) return HEARTBEAT;

    const [phones, events, syncError] = await Promise.all([
      listPhones(session.userId, database),
      database.execute({ sql: "SELECT max(id) AS id FROM events WHERE user_id = ?", args: [session.userId] }),
      readSyncError(database, session.userId),
    ]);
    // Keep the version from before the reads so a concurrent write forces another snapshot.
    previousVersion = authorized.version;
    return { phones, events: events.rows, syncError };
  };
}
