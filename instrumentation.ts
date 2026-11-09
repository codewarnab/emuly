export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.EMULY_MOCK === "1" || process.env.VERCEL) return;
  const { reconcile } = await import("./lib/phone/reconcile");
  const global = globalThis as unknown as { __emulyPoller?: ReturnType<typeof setInterval> };
  if (global.__emulyPoller) return;
  global.__emulyPoller = setInterval(() => { void reconcile().catch(() => console.warn("Phone state reconciliation could not run.")); }, 60_000);
  global.__emulyPoller.unref();
}
