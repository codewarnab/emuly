import type { DatabaseSync } from "node:sqlite";
import { webhookTarget, signWebhook, sendWebhook, type SendWebhook, type ResolveHost } from "./webhook-security.ts";

// One initial attempt, followed by five retries. Each delay starts after a failure.
const RETRY_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000];
const FAILURE_WINDOW = 3 * 86_400_000;

export function createWebhookOutbox({ database, decrypt, baseUrl, resolve, send = sendWebhook, clock = Date.now }: {
  database: DatabaseSync; decrypt: (cipher: Uint8Array) => string; baseUrl: string;
  resolve?: ResolveHost; send?: SendWebhook; clock?: () => number;
}) {
  let running = false;
  function disableFailing() {
    const cutoff = new Date(clock() - FAILURE_WINDOW).toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const failed = database.prepare(`SELECT id, user_id FROM webhooks w WHERE enabled = 1 AND failing_since <= ?
        -- Only failures since failing_since (a success clears it), and attempts still failing 3 days later.
        AND (SELECT max(attempted_at) FROM webhook_deliveries d WHERE d.webhook_id = w.id)
          >= strftime('%Y-%m-%dT%H:%M:%fZ', failing_since, '+3 days')`).all(cutoff);
      for (const hook of failed) {
        database.prepare("UPDATE webhooks SET enabled = 0 WHERE id = ?").run(hook.id!);
        database.prepare("INSERT INTO events (user_id, ts, kind, message) VALUES (?, ?, 'webhook.disabled', ?)")
          .run(hook.user_id!, new Date(clock()).toISOString(), `Webhook ${hook.id} disabled after 3 days of only failures. Re-enable it in Settings → Webhooks.`);
      }
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }
  async function deliver(row: { id: string; webhook_id: string; url: string; body: string; type: string; attempt: number }) {
    // Lease the delivery before awaiting DNS. HTTP tests and poller ticks can overlap.
    // An interrupted process leaves a short lease, so the outbox can retry later.
    const claimed = database.prepare(`UPDATE webhook_deliveries SET next_try_at = ?
      WHERE id = ? AND state = 'pending' AND next_try_at <= ?`)
      .run(new Date(clock() + 30_000).toISOString(), row.id, new Date(clock()).toISOString());
    if (!claimed.changes) return;
    const start = clock();
    let status: number | null = null;
    let canceled = false;
    const signal = AbortSignal.timeout(10_000);
    // The deadline covers DNS too. The transport uses the same signal for its socket.
    const deadline = new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Webhook timed out")), { once: true });
    });
    try {
      status = await Promise.race([deadline, (async () => {
        const target = await webhookTarget(row.url, baseUrl, resolve);
        signal.throwIfAborted();
        // Read current secret after DNS so rotation takes effect for queued deliveries.
        const hook = database.prepare("SELECT secret_cipher, enabled, url FROM webhooks WHERE id = ?").get(row.webhook_id);
        if (!hook?.enabled || hook.url !== row.url) { canceled = true; return 0; }
        return send(target, row.body, {
          "content-type": "application/json", "phonelink-event": row.type, "phonelink-delivery": row.id,
          "phonelink-signature": signWebhook(decrypt(hook.secret_cipher as Uint8Array), row.body, Math.floor(clock() / 1000)),
        }, signal);
      })()]);
    } catch { /* No provider text or URL enters the log. A missing status means network failure. */ }
    if (canceled) {
      database.prepare("UPDATE webhook_deliveries SET next_try_at = ? WHERE id = ?")
        .run(new Date(clock()).toISOString(), row.id);
      return;
    }
    const ok = status !== null && status >= 200 && status < 300;
    const delay = RETRY_MS[row.attempt];
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`UPDATE webhook_deliveries SET attempt = attempt + 1, status = ?, duration_ms = ?, attempted_at = ?,
        state = ?, next_try_at = ? WHERE id = ?`).run(status, Math.max(0, clock() - start), new Date(clock()).toISOString(),
          ok ? "ok" : delay === undefined ? "failed" : "pending", !ok && delay !== undefined ? new Date(clock() + delay).toISOString() : null, row.id);
      database.prepare("UPDATE webhooks SET failing_since = CASE WHEN ? THEN NULL ELSE COALESCE(failing_since, ?) END WHERE id = ?")
        .run(ok ? 1 : 0, new Date(clock()).toISOString(), row.webhook_id);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }
  return async function flush(deliveryId?: string) {
    if (!deliveryId && running) return;
    if (!deliveryId) running = true;
    try {
      disableFailing();
      const due = database.prepare(`SELECT d.*, w.url FROM webhook_deliveries d
        JOIN webhooks w ON w.id = d.webhook_id JOIN users u ON u.id = w.user_id
        WHERE d.state = 'pending' AND d.next_try_at <= ? AND w.enabled = 1 AND u.blocked = 0
        AND (? IS NULL OR d.id = ?)
        ORDER BY d.next_try_at, d.rowid LIMIT 50`).all(new Date(clock()).toISOString(), deliveryId ?? null, deliveryId ?? null) as Parameters<typeof deliver>[0][];
      // Bound simultaneous sockets. One slow receiver does not block other endpoints.
      for (let i = 0; i < due.length; i += 5) await Promise.all(due.slice(i, i + 5).map(deliver));
      disableFailing();
    } finally { if (!deliveryId) running = false; }
  };
}
