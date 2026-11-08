import { randomUUID } from "node:crypto";
import type { DatabaseQueries } from "./async-database.ts";
import { asyncDb } from "./async-db.ts";
import { WEBHOOK_EVENTS } from "../webhooks/webhook-event-types.ts";

export { WEBHOOK_EVENTS } from "../webhooks/webhook-event-types.ts";

export type OutgoingEvent = {
  userId: number;
  type: string;
  createdAt: string;
  data: Record<string, unknown>;
  /** Internal routing for the Test button; never serialized into the payload. */
  webhookId?: string;
};
export type EventEmitter = (event: OutgoingEvent) => void | Promise<unknown>;
function safeText(value: string) {
  return value.replace(/(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/(?:https?|wss?):\/\/\S+/gi, "[url removed]")
    .replace(/(?:authorization|cookie|\w*(?:token|secret|password))\s*[:=]\s*[^\r\n]+/gi, "[redacted]").slice(0, 2000);
}

/** Explicit payload fields prevent accidental serialization of stored credentials. */
function publicData(data: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const key of ["reason", "message", "threshold", "month", "estimated", "hours_left_at_current_rate", "days", "retention_at"]) {
    const value = data[key];
    if (typeof value === "string") result[key] = safeText(value);
    else if (value === null || typeof value === "boolean" || typeof value === "number") result[key] = value;
  }
  if (data.phone && typeof data.phone === "object") {
    const phone = data.phone as Record<string, unknown>;
    result.phone = Object.fromEntries(["id", "name", "state", "machine"].flatMap(key =>
      typeof phone[key] === "string" ? [[key, safeText(phone[key])]] : []));
  }
  return result;
}

export function eventStatement(event: OutgoingEvent) {
  if (!(WEBHOOK_EVENTS as readonly string[]).includes(event.type)) throw new Error("Unknown webhook event");
  const id = `evt_${randomUUID()}`;
  const body = JSON.stringify({ id, type: event.type, version: 1, created_at: event.createdAt, data: publicData(event.data) });
  // One statement keeps fan-out atomic, including within a caller's transaction.
  return { sql: `INSERT INTO webhook_deliveries
    (id, webhook_id, event_id, type, body, next_try_at, state, created_at)
    SELECT 'dlv_' || lower(hex(randomblob(16))), id, ?, ?, ?, ?, 'pending', ? FROM webhooks
    WHERE user_id = ? AND enabled = 1 AND (? IS NULL OR id = ?) AND (? IS NOT NULL OR events = '*' OR EXISTS
      (SELECT 1 FROM json_each(CASE WHEN events = '*' THEN '[]' ELSE events END) WHERE value = ?))`, args: [id, event.type, body, event.createdAt, event.createdAt, event.userId, event.webhookId ?? null, event.webhookId ?? null, event.webhookId ?? null, event.type] };
}

/** The supplied handle keeps fan-out inside a caller's transaction. */
export function createEventEmitter(database: DatabaseQueries) {
return async (event: OutgoingEvent) => {
  const statement = eventStatement(event);
  await database.execute(statement);
  return String(statement.args[0]);
};
}

export function emitEvent(event: OutgoingEvent, database: DatabaseQueries = asyncDb()) { return createEventEmitter(database)(event); }
