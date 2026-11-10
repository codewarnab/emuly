import "server-only";
import { asyncDb } from "../data/async-db.ts";
import type { AgentAction } from "./agent-action.ts";

export type AgentActionEvent = { id: number; at: string; action: AgentAction };

function point(value: unknown): value is { x: number; y: number } {
  if (value === null || typeof value !== "object") return false;
  const { x, y } = value as { x?: unknown; y?: unknown };
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y);
}

/** Rows are written by us, but a corrupt blob must never reach the UI. */
function asAgentAction(value: unknown): AgentAction | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as { type?: unknown; x?: unknown; y?: unknown; from?: unknown; to?: unknown; key?: unknown; label?: unknown };
  switch (candidate.type) {
    case "tap": return point(candidate) ? { type: "tap", x: candidate.x, y: candidate.y } : null;
    case "swipe": {
      const { from, to } = candidate;
      return point(from) && point(to) ? { type: "swipe", from, to } : null;
    }
    case "key":
      return candidate.key === "back" || candidate.key === "home" || candidate.key === "recent" || candidate.key === "other"
        ? { type: "key", key: candidate.key } : null;
    case "text": return { type: "text" };
    case "command":
      return candidate.label === "Installing app" || candidate.label === "Taking screenshot"
        ? { type: "command", label: candidate.label } : null;
    default: return null;
  }
}

function storedAction(meta: unknown): AgentAction | null {
  if (typeof meta !== "string") return null;
  try {
    const parsed = JSON.parse(meta) as { action?: unknown } | null;
    return asAgentAction(parsed?.action);
  } catch { return null; }
}

/** Actions newer than afterId, oldest first so the caller can advance its cursor by the last id. */
export async function readAgentActions(userId: number, phoneId: string, afterId: number): Promise<AgentActionEvent[]> {
  const rows = (await asyncDb().execute({
    sql: `SELECT id, ts, meta FROM events
      WHERE user_id = ? AND phone_id = ? AND kind = 'adb' AND id > ? AND json_extract(meta, '$.action') IS NOT NULL
      ORDER BY id LIMIT 50`,
    args: [userId, phoneId, afterId],
  })).rows;
  return rows.flatMap(row => {
    const action = storedAction(row.meta);
    return action ? [{ id: Number(row.id), at: String(row.ts), action }] : [];
  });
}

/** Cursor seed for a new stream, so actions recorded before it started are not replayed. */
export async function latestEventId(userId: number, phoneId: string): Promise<number> {
  const row = (await asyncDb().execute({
    sql: "SELECT max(id) AS id FROM events WHERE user_id = ? AND phone_id = ?",
    args: [userId, phoneId],
  })).rows[0];
  return Number(row?.id ?? 0);
}
