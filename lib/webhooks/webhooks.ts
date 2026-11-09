import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { transaction, type DatabaseQueries } from "../data/async-database.ts";
import { createEventEmitter, emitEvent, WEBHOOK_EVENTS } from "../data/events.ts";
import { webhookTarget, WebhookInputError, type ResolveHost } from "./webhook-security.ts";

export type Webhook = { id: string; url: string; events: "*" | string[]; enabled: boolean; created_at: string; failing_since: string | null };
export type Delivery = { id: string; event_id: string; type: string; created_at: string; attempted_at: string | null;
  attempt: number; status: number | null; duration_ms: number | null; state: string; next_try_at: string | null };
type StoredWebhook = Omit<Webhook, "events" | "enabled"> & { events: string; enabled: number };
export class WebhookRateLimitError extends WebhookInputError {}

export function createWebhookService({ database, encrypt, baseUrl, resolve, deliver, clock = Date.now }: {
  database: Client; encrypt: (plain: string) => Uint8Array; baseUrl: string; resolve?: ResolveHost; clock?: () => number;
  deliver?: (id: string) => Promise<void>;
}) {
  const iso = () => new Date(clock()).toISOString();
  const publicHook = (row: StoredWebhook): Webhook => ({ ...row, events: row.events === "*" ? "*" : JSON.parse(row.events), enabled: Boolean(row.enabled) });
  const columns = "id, url, events, enabled, created_at, failing_since";
  async function owned(userId: number, id: string, queries: DatabaseQueries = database) {
    const row = (await queries.execute({ sql: `SELECT ${columns} FROM webhooks WHERE id = ? AND user_id = ?`, args: [id, userId] })).rows[0] as unknown as StoredWebhook | undefined;
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
  async function enqueueTest(userId: number, id: string) {
    // Keep the rate check and enqueue atomic across server processes.
    return transaction(database, async queries => {
      if (!(await owned(userId, id, queries)).enabled) throw new WebhookInputError("Re-enable this webhook before testing it.");
      const recent = (await queries.execute({ sql: `SELECT 1 FROM webhook_deliveries
        WHERE webhook_id = ? AND type = 'webhook.test' AND created_at > ? LIMIT 1`, args: [id, new Date(clock() - 5000).toISOString()] })).rows[0];
      if (recent) throw new WebhookRateLimitError("Wait 5 seconds before sending another test.");
      const eventId = await emitEvent({ userId, type: "webhook.test", createdAt: iso(), data: {}, webhookId: id }, queries);
      const delivery = (await queries.execute({ sql: "SELECT id FROM webhook_deliveries WHERE webhook_id = ? AND event_id = ?", args: [id, eventId] })).rows[0] as unknown as { id: string };
      return delivery;
    });
  }
  return {
    async list(userId: number) {
      return ((await database.execute({ sql: `SELECT ${columns} FROM webhooks WHERE user_id = ? ORDER BY created_at, id`, args: [userId] })).rows as unknown as StoredWebhook[]).map(publicHook);
    },
    /** One endpoint's read-only details. The signing secret is never part of this shape. */
    async get(userId: number, id: string) {
      return publicHook(await owned(userId, id));
    },
    async create(userId: number, value: unknown) {
      const body = input(value);
      const target = await webhookTarget(body.url, baseUrl, resolve);
      const events = selection(body.events ?? "*");
      const id = `wh_${randomUUID()}`;
      const secret = `whsec_${randomBytes(32).toString("base64url")}`;
      await database.execute({ sql: `INSERT INTO webhooks (id, user_id, url, events, secret_cipher, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, args: [id, userId, target.url.href, events, encrypt(secret), body.enabled === false ? 0 : 1, iso()] });
      return { ...publicHook(await owned(userId, id)), secret };
    },
    async update(userId: number, id: string, value: unknown) {
      await owned(userId, id);
      const body = input(value);
      const url = body.url === undefined ? undefined : (await webhookTarget(body.url, baseUrl, resolve)).url.href;
      const events = body.events === undefined ? undefined : selection(body.events);
      const secret = body.roll_secret ? `whsec_${randomBytes(32).toString("base64url")}` : undefined;
      // URL validation awaits DNS. Recheck ownership after that wait.
      await owned(userId, id);
      await database.execute({ sql: `UPDATE webhooks SET url = COALESCE(?, url), events = COALESCE(?, events),
        enabled = COALESCE(?, enabled), secret_cipher = COALESCE(?, secret_cipher),
        failing_since = CASE WHEN ? IS NOT NULL THEN NULL ELSE failing_since END WHERE id = ? AND user_id = ?`, args: [url ?? null, events ?? null, body.enabled === undefined ? null : Number(body.enabled), secret ? encrypt(secret) : null, body.enabled === undefined ? null : Number(body.enabled), id, userId] });
      return { ...publicHook(await owned(userId, id)), ...(secret ? { secret } : {}) };
    },
    async remove(userId: number, id: string) {
      await owned(userId, id);
      await database.execute({ sql: "DELETE FROM webhooks WHERE id = ? AND user_id = ?", args: [id, userId] });
      return { deleted: true };
    },
    test: enqueueTest,
    async testNow(userId: number, id: string) {
      if (!deliver) throw new Error("Webhook delivery is not configured.");
      const queued = await enqueueTest(userId, id);
      await deliver(queued.id);
      return (await database.execute({ sql: `SELECT id, state, status, duration_ms FROM webhook_deliveries WHERE id = ?`, args: [queued.id] })).rows[0];
    },
    async deliveries(userId: number, id: string) {
      await owned(userId, id);
      return (await database.execute({ sql: `SELECT id, event_id, type, created_at, attempted_at, attempt, status, duration_ms, state, next_try_at
        FROM webhook_deliveries WHERE webhook_id = ? ORDER BY rowid DESC LIMIT 50`, args: [id] })).rows as unknown as Delivery[];
    },
    async resend(userId: number, id: string, deliveryId: string) {
      await owned(userId, id);
      const newId = `dlv_${randomUUID()}`;
      const result = await database.execute({ sql: `INSERT INTO webhook_deliveries
        (id, webhook_id, event_id, type, body, next_try_at, state, created_at)
        SELECT ?, webhook_id, event_id, type, body, ?, 'pending', ? FROM webhook_deliveries WHERE id = ? AND webhook_id = ?`, args: [newId, iso(), iso(), deliveryId, id] });
      if (!result.rowsAffected) throw new WebhookInputError("Delivery not found.");
      return { id: newId };
    },
    emit: createEventEmitter(database),
  };
}
