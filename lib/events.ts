import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { db } from "./db.ts";
import { WEBHOOK_EVENTS } from "./webhook-event-types.ts";

export { WEBHOOK_EVENTS } from "./webhook-event-types.ts";

export type OutgoingEvent = {
  userId: number;
  type: string;
  createdAt: string;
  data: Record<string, unknown>;
  /** Internal routing for the Test button; never serialized into the payload. */
  webhookId?: string;
};
export type EventEmitter = (event: OutgoingEvent) => void;
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

export function createEventEmitter(database: DatabaseSync) {
  return (event: OutgoingEvent) => {
    if (!(WEBHOOK_EVENTS as readonly string[]).includes(event.type)) throw new Error("Unknown webhook event");
    const id = `evt_${randomUUID()}`;
    const body = JSON.stringify({ id, type: event.type, version: 1, created_at: event.createdAt, data: publicData(event.data) });
    // One statement keeps fan-out atomic, including within a caller's transaction.
    database.prepare(`INSERT INTO webhook_deliveries
      (id, webhook_id, event_id, type, body, next_try_at, state, created_at)
      SELECT 'dlv_' || lower(hex(randomblob(16))), id, ?, ?, ?, ?, 'pending', ? FROM webhooks
      WHERE user_id = ? AND enabled = 1 AND (? IS NULL OR id = ?) AND (? IS NOT NULL OR events = '*' OR EXISTS
        (SELECT 1 FROM json_each(CASE WHEN events = '*' THEN '[]' ELSE events END) WHERE value = ?))`)
      .run(id, event.type, body, event.createdAt, event.createdAt, event.userId,
        event.webhookId ?? null, event.webhookId ?? null, event.webhookId ?? null, event.type);
    return id;
  };
}

export function emitEvent(event: OutgoingEvent, database: DatabaseSync = db()) { return createEventEmitter(database)(event); }
