import "server-only";
import { getUser } from "./auth/auth";
import { asyncDb } from "./data/async-db";
import { phoneControl, templateRepository } from "./phone/phone-control";
import { createPhoneApi } from "./phone/phone-api";
import { readUsage, userSettings } from "./data/usage";
import { webhookControl } from "./webhooks/webhook-control";
import { createWebhookApi } from "./webhooks/webhook-api";

export function webhookApi() { return createWebhookApi({ user: getUser, service: webhookControl() }); }

export function phoneApi() {
  return createPhoneApi({ user: getUser, service: phoneControl(), template: templateRepository,
    usage: async id => (await readUsage(asyncDb(), id)), defaults: async id => (await userSettings(asyncDb(), id)) });
}
