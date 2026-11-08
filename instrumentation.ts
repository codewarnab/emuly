export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.PHONELINK_MOCK === "1" || process.env.VERCEL) return;
  const { reconcile } = await import("./lib/phone/reconcile");
  const global = globalThis as unknown as { __phonelinkPoller?: ReturnType<typeof setInterval> };
  if (global.__phonelinkPoller) return;
  global.__phonelinkPoller = setInterval(() => { void reconcile().catch(() => console.warn("Phone state reconciliation could not run.")); }, 60_000);
  global.__phonelinkPoller.unref();
}
