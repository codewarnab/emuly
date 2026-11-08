import { asyncDb } from "../data/async-db.ts";
import { withLease } from "../data/coordination.ts";
import { latestPhoneControl } from "./phone-control.ts";
import { createStatePoller } from "./poller.ts";
import { webhookOutbox } from "../webhooks/webhook-control.ts";
import { createDiagnostics } from "../diagnostics/diagnostics.ts";

export async function reconcile() {
  const database = asyncDb();
  return withLease(database, "scheduled:reconcile", async () => {
    const diagnostics = createDiagnostics(database);
    await diagnostics.reconcile();
    await diagnostics.prune();
    const control = latestPhoneControl();
    await createStatePoller({ database, sync: id => control.sync(id),
      autoStop: (userId, id) => control.autoStop(userId, id),
      autoKeep: (userId, id) => control.autoKeep(userId, id), deliver: webhookOutbox() })();
  });
}
