import "server-only";
import { getUser } from "./auth";
import { db } from "./db";
import { phoneControl, templateRepository } from "./phone/phone-control";
import { createPhoneApi } from "./phone/phone-api";
import { readUsage, userSettings } from "./usage";
import { webhookControl } from "./webhook-control";
import { createWebhookApi } from "./webhook-api";

export function webhookApi() { return createWebhookApi({ user: getUser, service: webhookControl() }); }

export function phoneApi() {
  return createPhoneApi({ user: getUser, service: phoneControl(), template: templateRepository,
    usage: id => readUsage(db(), id), defaults: id => userSettings(db(), id) });
}
