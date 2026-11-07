/** Shared names only: safe to import from client components. */
export const WEBHOOK_EVENTS = ["phone.created", "phone.starting", "phone.ready", "phone.stopped", "phone.deleted",
  "phone.kept", "phone.error", "hours.low", "hours.auto_stopped", "retention.warning", "webhook.test"] as const;
