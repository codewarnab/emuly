import { asyncDb } from "../data/async-db.ts";
import { withLease } from "../data/coordination.ts";
import { latestPhoneControl } from "./phone-control.ts";
import { createStatePoller } from "./poller.ts";
import { webhookOutbox } from "../webhooks/webhook-control.ts";
import { createDiagnostics } from "../diagnostics/diagnostics.ts";
import { purgeDeletedPhones } from "../data/purge-deleted-phones.ts";
import { stopIdlePhones } from "./idle-stop.ts";
import { runnerAndroidIdleMs } from "./phone-runner.ts";
import { createSyncGate } from "./sync-gate.ts";
import { recordSchedulerRun } from "./scheduler-health.ts";

export async function reconcile() {
  const database = asyncDb();
  return withLease(database, "scheduled:reconcile", () => recordSchedulerRun(database, "reconcile", async () => {
    const diagnostics = createDiagnostics(database);
    await diagnostics.reconcile();
    await diagnostics.prune();
    await purgeDeletedPhones(database);
    const control = latestPhoneControl();
    await stopIdlePhones({ database, stop: (userId, id) => control.idleStop(userId, id),
      androidIdleMs: phone => runnerAndroidIdleMs(phone.userId, phone.id, phone.codespaceName) });
    // The scheduler always syncs; the gate records the result so page loads skip a second GitHub call.
    const gate = createSyncGate({ database, sync: id => control.sync(id) });
    await createStatePoller({ database, sync: async id => { await gate.run(id, "always"); },
      autoStop: (userId, id) => control.autoStop(userId, id),
      autoKeep: (userId, id) => control.autoKeep(userId, id), deliver: webhookOutbox() })();
  }));
}
