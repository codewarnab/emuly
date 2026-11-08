import "server-only";
import { asyncDb } from "../data/async-db";
import { seal, open } from "../auth/crypto";
import { env } from "../env";
import { createWebhookService } from "./webhooks";
import { createWebhookOutbox } from "./webhook-outbox";

export function webhookControl() {
  return createWebhookService({ database: asyncDb(), encrypt: seal, baseUrl: env.baseUrl, deliver: webhookOutbox() });
}

export function webhookOutbox() {
  return createWebhookOutbox({ database: asyncDb(), decrypt: open, baseUrl: env.baseUrl });
}
