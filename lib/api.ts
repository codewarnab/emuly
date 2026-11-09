import "server-only";
import { getUser } from "./auth/auth";
import { asyncDb } from "./data/async-db";
import { env } from "./env";
import { phoneControl, templateRepository } from "./phone/phone-control";
import { createPhoneApi } from "./phone/phone-api";
import { createPhoneAgentApi } from "./phone/phone-agent-api";
import { findPhone, listPhones } from "./phone/phones";
import { runnerAdb } from "./phone/phone-runner";
import { recordPhoneAdb } from "./phone/phone-activity";
import { readUsage, userSettings } from "./data/usage";
import { webhookControl } from "./webhooks/webhook-control";
import { createWebhookApi } from "./webhooks/webhook-api";

export function webhookApi() { return createWebhookApi({ user: getUser, service: webhookControl() }); }

export function phoneApi() {
  return createPhoneApi({ user: getUser, service: phoneControl(), template: templateRepository,
    usage: async id => (await readUsage(asyncDb(), id)), defaults: async id => (await userSettings(asyncDb(), id)) });
}

/** List/read/start/stop/adb share the agent-facing surface and the same origin rule. */
export function agentPhoneApi() {
  return createPhoneAgentApi({ user: getUser, phones: listPhones, phone: findPhone, service: phoneControl(),
    adb: runnerAdb, baseUrl: () => env.baseUrl, log: recordPhoneAdb });
}
