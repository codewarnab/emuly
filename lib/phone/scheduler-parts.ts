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
  return {
    sync: async userId => { await gate.run(userId, "always"); },
    backoffLeft: poller.backoffLeft, clearBackoff: poller.clearBackoff, backOff: poller.backOff,
    protectBudget: poller.protectBudget, protectRetention: poller.protectRetention,
    deliver: () => deliver(),
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
