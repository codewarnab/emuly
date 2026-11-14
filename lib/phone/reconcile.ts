import { asyncDb } from "../data/async-db.ts";
import { withLease } from "../data/coordination.ts";
import { latestPhoneControl } from "./phone-control.ts";
import { createStatePoller } from "./poller.ts";
import { webhookOutbox } from "../webhooks/webhook-control.ts";
import { createDiagnostics } from "../diagnostics/diagnostics.ts";
import { purgeDeletedPhones } from "../data/purge-deleted-phones.ts";
import { stopIdlePhones } from "./idle-stop.ts";
import { runnerAndroidIdleMs } from "./phone-runner.ts";

export async function reconcile() {
  const database = asyncDb();
  return withLease(database, "scheduled:reconcile", async () => {
    const diagnostics = createDiagnostics(database);
    await diagnostics.reconcile();
    await diagnostics.prune();
    await purgeDeletedPhones(database);
    const control = latestPhoneControl();
    await stopIdlePhones({ database, stop: (userId, id) => control.idleStop(userId, id),
      androidIdleMs: phone => runnerAndroidIdleMs(phone.userId, phone.id, phone.codespaceName) });
    await createStatePoller({ database, sync: id => control.sync(id),
      autoStop: (userId, id) => control.autoStop(userId, id),
      autoKeep: (userId, id) => control.autoKeep(userId, id), deliver: webhookOutbox() })();
  });
}
