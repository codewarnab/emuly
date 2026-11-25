import { asyncDb } from "../data/async-db.ts";
import { latestPhoneControl } from "./phone-control.ts";
import { createStatePoller } from "./poller.ts";
import { webhookOutbox } from "../webhooks/webhook-control.ts";
import { createDiagnostics } from "../diagnostics/diagnostics.ts";
import { purgeDeletedPhones } from "../data/purge-deleted-phones.ts";
import { stopIdlePhones } from "./idle-stop.ts";
import { runnerAndroidIdleMs } from "./phone-runner.ts";
import { createSyncGate } from "./sync-gate.ts";
import type { SchedulerParts } from "./scheduler.ts";
import { createPhoneSetup, RUNNER_VERSION, scriptsVersion } from "./phone-setup.ts";
import { createRunnerUpdater } from "./runner-update.ts";
import { runnerKeyFingerprint, runnerSecret } from "./direct-ticket.ts";
import { getAccessToken } from "../github/github-token.ts";
import { withLease } from "../data/coordination.ts";
import { DEFAULT_DEVICE_PRESET } from "../shared/device-presets.ts";

/** The real work behind each scheduler loop. /api/cron (lib/phone/reconcile.ts) runs the same work in one pass. */
export function schedulerParts(): SchedulerParts {
  const database = asyncDb();
  const control = () => latestPhoneControl();
  // The gate records each sync, so a page load in the next 15 s skips a second GitHub call.
  const gate = createSyncGate({ database, sync: id => control().sync(id) });
  const poller = createStatePoller({ database, sync: async () => {},
    autoStop: (userId, id) => control().autoStop(userId, id),
    autoKeep: (userId, id) => control().autoKeep(userId, id) });
  const deliver = webhookOutbox();
  const setup = createPhoneSetup({ token: userId => getAccessToken(userId) });
  let scripts: string | undefined;
  // In-place runner update: a running phone gets a new runner after a deploy, without a phone stop.
  const runners = createRunnerUpdater({ database, version: RUNNER_VERSION, scripts: () => scripts ??= scriptsVersion(),
    health: phone => setup.readHealth(phone.userId, phone.codespaceName),
    // A runner with an old key (after EMULY_DIRECT_SECRET changes) gets setup again, which writes the new key.
    keyFingerprint: name => runnerKeyFingerprint(runnerSecret(name)),
    androidIdleMs: phone => runnerAndroidIdleMs(phone.userId, phone.id, phone.codespaceName),
    install: phone => setup(phone.userId, phone.codespaceName, (phone.devicePreset ?? DEFAULT_DEVICE_PRESET) as Parameters<typeof setup>[2]),
    // The same lease as a user's start, stop and create (phone-mutations.ts), so they never overlap.
    withUserLease: (userId, work) => withLease(database, `phones:${userId}`, work) });
  return {
    sync: async userId => { await gate.run(userId, "always"); },
    backoffLeft: poller.backoffLeft, clearBackoff: poller.clearBackoff, backOff: poller.backOff,
    protectBudget: poller.protectBudget, protectRetention: poller.protectRetention,
    deliver: () => deliver(),
    updateRunners: async () => { await runners.pass(); },
    async minute() {
      const diagnostics = createDiagnostics(database);
      await diagnostics.reconcile();
      await diagnostics.prune();
      await purgeDeletedPhones(database);
      await stopIdlePhones({ database, stop: (userId, id) => control().idleStop(userId, id),
        androidIdleMs: phone => runnerAndroidIdleMs(phone.userId, phone.id, phone.codespaceName) });
    },
  };
}
