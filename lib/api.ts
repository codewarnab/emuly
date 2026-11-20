import "server-only";
import { DIRECT_BLOCKED_HINT, directBlocked } from "./phone/network-hint";
import { getUser } from "./auth/auth";
import { asyncDb } from "./data/async-db";
import { env } from "./env";
import { phoneControl, templateRepository } from "./phone/phone-control";
import { createPhoneApi } from "./phone/phone-api";
import { createPhoneAgentApi } from "./phone/phone-agent-api";
import { findPhone, listPhones } from "./phone/phones";
import { runnerAdb, runnerAgentDevice, runnerLinks, runnerRecording, runnerRequest } from "./phone/phone-runner";
import { createPhoneLinksApi } from "./phone/phone-links-api";
import { issueLinkTicket } from "./phone/link-ticket";
import { directUploadTicket } from "./phone/direct-upload";
import { recordPhoneAdb, recordPhoneAgentAction } from "./phone/phone-activity";
import { readUsage, userSettings } from "./data/usage";
import { SELF_HOST } from "./selfhost";
import { AGENT_RUNBOOK_VERSION, SKILL_NAME, skillVersion } from "./agent-runbook";
import { skillUpdate } from "./skill-update";
import { createUpdateCheck, dismissFileFor } from "./update-check";
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
    adb: runnerAdb, uploadTicket: directUploadTicket, agentDevice: runnerAgentDevice, recording: runnerRecording,
    screenshot: (userId, id, scale) => runnerRequest(userId, id, "/screenshot", undefined, scale === undefined ? undefined : { scale: String(scale) }),
    baseUrl: () => env.baseUrl, log: recordPhoneAdb, action: recordPhoneAgentAction,
    update: () => updateCheck().hint(env.baseUrl),
    skillUpdate: request => skillUpdate(request, skillVersion(), env.baseUrl, SKILL_NAME),
    networkHint: async userId => await directBlocked(asyncDb(), userId) ? DIRECT_BLOCKED_HINT : null });
}

/** Links and net-check. Agent keys and the console use the same routes. */
export function linksApi() {
  return createPhoneLinksApi({ user: getUser, phone: findPhone, runner: runnerLinks,
    issue: ticket => issueLinkTicket(asyncDb(), ticket), baseUrl: () => env.baseUrl,
    owner: async userId => (await asyncDb().execute({ sql: "SELECT login FROM users WHERE id = ?", args: [userId] })).rows[0]?.login as string | undefined });
}

let updateCheckInstance: ReturnType<typeof createUpdateCheck> | undefined;
/** One per process, so the daily GitHub read is shared by every request. */
export function updateCheck() {
  return updateCheckInstance ??= createUpdateCheck({
    current: AGENT_RUNBOOK_VERSION,
    enabled: SELF_HOST && process.env.EMULY_UPDATE_CHECK !== "0",
    dismissFile: dismissFileFor(env.dbPath),
    fetchText: async url => {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`update check: ${response.status}`);
      return response.text();
    },
  });
}
