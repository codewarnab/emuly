// The Emuly scheduler for the OCI VM: one long-running process instead of the 60 s /api/cron call.
// Run: node --import ./scripts/node-resolve.mjs --conditions=react-server --experimental-strip-types scripts/scheduler.ts
// It needs the same env vars as the Vercel app (database, GitHub app, token key, direct and webhook secrets).
// It never prints env values or provider errors.
import { asyncDb } from "../lib/data/async-db.ts";
import { createScheduler } from "../lib/phone/scheduler.ts";
import { schedulerParts } from "../lib/phone/scheduler-parts.ts";

for (const name of ["EMULY_DATABASE_URL", "EMULY_DATABASE_AUTH_TOKEN", "EMULY_TOKEN_KEY", "EMULY_GITHUB_CLIENT_ID", "EMULY_GITHUB_CLIENT_SECRET"]) {
  if (!process.env[name] && !(name.startsWith("EMULY_DATABASE") && process.env.EMULY_DB)) {
    console.error(`[scheduler] missing env var ${name}`);
    process.exit(78);
  }
}

const scheduler = createScheduler({ database: asyncDb(), parts: schedulerParts(),
  limit: Number(process.env.EMULY_SCHEDULER_PARALLEL ?? 8) });
let exiting = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
  if (exiting) return;
  exiting = true;
  console.log(`[scheduler] ${signal}: finishing running work`);
  // systemd waits 90 s; give running work 60 s, then exit.
  void scheduler.stop(60_000).finally(() => process.exit(0));
});
// A fault in background work (a boot, a setup) must not end the process: the next sync retries it.
process.on("unhandledRejection", error => console.error(`[scheduler] background work failed: ${error instanceof Error ? error.name : "unknown"}`));
console.log("[scheduler] started");
void scheduler.start();
