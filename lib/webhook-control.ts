import "server-only";
import { db } from "./db";
import { seal, open } from "./crypto";
import { env } from "./env";
import { createWebhookService } from "./webhooks";
import { createWebhookOutbox } from "./webhook-outbox";

export function webhookControl() {
  return createWebhookService({ database: db(), encrypt: seal, baseUrl: env.baseUrl, deliver: webhookOutbox() });
}

export function webhookOutbox() {
  return createWebhookOutbox({ database: db(), decrypt: open, baseUrl: env.baseUrl });
}
