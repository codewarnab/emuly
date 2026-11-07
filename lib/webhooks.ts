import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createEventEmitter, emitEvent, WEBHOOK_EVENTS } from "./events.ts";
import { webhookTarget, WebhookInputError, type ResolveHost } from "./webhook-security.ts";

export type Webhook = { id: string; url: string; events: "*" | string[]; enabled: boolean; created_at: string; failing_since: string | null };
export type Delivery = { id: string; event_id: string; type: string; created_at: string; attempted_at: string | null;
  attempt: number; status: number | null; duration_ms: number | null; state: string; next_try_at: string | null };
type StoredWebhook = Omit<Webhook, "events" | "enabled"> & { events: string; enabled: number };
export class WebhookRateLimitError extends WebhookInputError {}

export function createWebhookService({ database, encrypt, baseUrl, resolve, deliver, clock = Date.now }: {
  database: DatabaseSync; encrypt: (plain: string) => Uint8Array; baseUrl: string; resolve?: ResolveHost; clock?: () => number;
  deliver?: (id: string) => Promise<void>;
}) {
  const iso = () => new Date(clock()).toISOString();
  const publicHook = (row: StoredWebhook): Webhook => ({ ...row, events: row.events === "*" ? "*" : JSON.parse(row.events), enabled: Boolean(row.enabled) });
  const columns = "id, url, events, enabled, created_at, failing_since";
  function owned(userId: number, id: string) {
    const row = database.prepare(`SELECT ${columns} FROM webhooks WHERE id = ? AND user_id = ?`).get(id, userId) as StoredWebhook | undefined;
    if (!row) throw new WebhookInputError("Webhook not found.");
    return row;
  }
  function input(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebhookInputError("Expected a JSON object.");
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some(key => !["url", "events", "enabled", "roll_secret"].includes(key))) throw new WebhookInputError("Unknown webhook setting.");
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new WebhookInputError("enabled must be true or false.");
    if (body.roll_secret !== undefined && typeof body.roll_secret !== "boolean") throw new WebhookInputError("roll_secret must be true or false.");
    return body;
  }
  function selection(value: unknown) {
    if (value === "*") return "*";
    if (!Array.isArray(value) || !value.length || value.some(event => !(WEBHOOK_EVENTS as readonly unknown[]).includes(event))) {
      throw new WebhookInputError("Pick at least one supported event, or all events (*).");
    }
    return JSON.stringify([...new Set(value)]);
  }
  function enqueueTest(userId: number, id: string) {
    // Keep the rate check and enqueue atomic across server processes.
    database.exec("BEGIN IMMEDIATE");
    try {
      if (!owned(userId, id).enabled) throw new WebhookInputError("Re-enable this webhook before testing it.");
      const recent = database.prepare(`SELECT 1 FROM webhook_deliveries
        WHERE webhook_id = ? AND type = 'webhook.test' AND created_at > ? LIMIT 1`)
        .get(id, new Date(clock() - 5000).toISOString());
      if (recent) throw new WebhookRateLimitError("Wait 5 seconds before sending another test.");
      const eventId = emitEvent({ userId, type: "webhook.test", createdAt: iso(), data: {}, webhookId: id }, database);
      const delivery = database.prepare("SELECT id FROM webhook_deliveries WHERE webhook_id = ? AND event_id = ?").get(id, eventId) as { id: string };
      database.exec("COMMIT");
      return delivery;
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }
  return {
    list(userId: number) {
      return (database.prepare(`SELECT ${columns} FROM webhooks WHERE user_id = ? ORDER BY created_at, id`).all(userId) as StoredWebhook[]).map(publicHook);
    },
    async create(userId: number, value: unknown) {
      const body = input(value);
      const target = await webhookTarget(body.url, baseUrl, resolve);
      const events = selection(body.events ?? "*");
      const id = `wh_${randomUUID()}`;
      const secret = `whsec_${randomBytes(32).toString("base64url")}`;
      database.prepare(`INSERT INTO webhooks (id, user_id, url, events, secret_cipher, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, userId, target.url.href, events, encrypt(secret), body.enabled === false ? 0 : 1, iso());
      return { ...publicHook(owned(userId, id)), secret };
    },
    async update(userId: number, id: string, value: unknown) {
      owned(userId, id);
      const body = input(value);
      const url = body.url === undefined ? undefined : (await webhookTarget(body.url, baseUrl, resolve)).url.href;
      const events = body.events === undefined ? undefined : selection(body.events);
      const secret = body.roll_secret ? `whsec_${randomBytes(32).toString("base64url")}` : undefined;
      // URL validation awaits DNS. Recheck ownership after that wait.
      owned(userId, id);
      database.prepare(`UPDATE webhooks SET url = COALESCE(?, url), events = COALESCE(?, events),
        enabled = COALESCE(?, enabled), secret_cipher = COALESCE(?, secret_cipher),
        failing_since = CASE WHEN ? IS NOT NULL THEN NULL ELSE failing_since END WHERE id = ? AND user_id = ?`)
        .run(url ?? null, events ?? null, body.enabled === undefined ? null : Number(body.enabled),
          secret ? encrypt(secret) : null, body.enabled === undefined ? null : Number(body.enabled), id, userId);
      return { ...publicHook(owned(userId, id)), ...(secret ? { secret } : {}) };
    },
    remove(userId: number, id: string) {
      owned(userId, id);
      database.prepare("DELETE FROM webhooks WHERE id = ? AND user_id = ?").run(id, userId);
      return { deleted: true };
    },
    test: enqueueTest,
    async testNow(userId: number, id: string) {
      if (!deliver) throw new Error("Webhook delivery is not configured.");
      const queued = enqueueTest(userId, id);
      await deliver(queued.id);
      return database.prepare(`SELECT id, state, status, duration_ms FROM webhook_deliveries WHERE id = ?`).get(queued.id);
    },
    deliveries(userId: number, id: string) {
      owned(userId, id);
      return database.prepare(`SELECT id, event_id, type, created_at, attempted_at, attempt, status, duration_ms, state, next_try_at
        FROM webhook_deliveries WHERE webhook_id = ? ORDER BY rowid DESC LIMIT 50`).all(id) as Delivery[];
    },
    resend(userId: number, id: string, deliveryId: string) {
      owned(userId, id);
      const newId = `dlv_${randomUUID()}`;
      const result = database.prepare(`INSERT INTO webhook_deliveries
        (id, webhook_id, event_id, type, body, next_try_at, state, created_at)
        SELECT ?, webhook_id, event_id, type, body, ?, 'pending', ? FROM webhook_deliveries WHERE id = ? AND webhook_id = ?`)
        .run(newId, iso(), iso(), deliveryId, id);
      if (!result.changes) throw new WebhookInputError("Delivery not found.");
      return { id: newId };
    },
    emit: createEventEmitter(database),
  };
}
