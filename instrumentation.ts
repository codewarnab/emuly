export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.PHONELINK_MOCK === "1") return;
  const { db } = await import("./lib/data/db");
  const { latestPhoneControl: phoneControl } = await import("./lib/phone/phone-control");
  const { createStatePoller } = await import("./lib/phone/poller");
  const { webhookOutbox } = await import("./lib/webhooks/webhook-control");
  const { createDiagnostics } = await import("./lib/diagnostics/diagnostics");
  const global = globalThis as unknown as { __phonelinkPoller?: ReturnType<typeof setInterval> };
  if (global.__phonelinkPoller) return;
  const diagnostics = createDiagnostics(db());
  diagnostics.reconcile();
  const deliver = webhookOutbox();
  const tick = createStatePoller({ database: db(), deliver: async () => { diagnostics.reconcile(); diagnostics.prune(); await deliver(); }, sync: userId => phoneControl().sync(userId),
    autoStop: (userId, phoneId) => phoneControl().autoStop(userId, phoneId),
    autoKeep: (userId, phoneId) => phoneControl().autoKeep(userId, phoneId) });
  global.__phonelinkPoller = setInterval(() => { void tick().catch(() => console.warn("Phone state reconciliation could not run.")); }, 60_000);
  global.__phonelinkPoller.unref();
}
