const DAY = 86_400_000;

export type Retention = { message: string; warning: boolean; canKeep: boolean; expiresAt: string };

// TODO(retention): protect stopped phones from GitHub's 30-day deletion instead of backups.
// - Show "Deleted in N days" on every stopped phone card, not only in the last 2 days.
// - Send a warning (event + webhook) at 7 days and at 1 day before expiry.
// - Show the "Keep it" button (start briefly, then stop; resets GitHub's timer) at any time, not only when canKeep.
/** Shared by cards, compact rows and policy. Provider dates take precedence. */
export function retentionStatus(phone: {
  state: string; retention_at: string | null; last_stopped_at: string | null; retention_min: number;
}, clock: () => number = Date.now): Retention | null {
  if (phone.state !== "stopped") return null;
  const expiry = retentionExpiry(phone);
  if (!expiry) return null;
  const remaining = Date.parse(expiry) - clock();
  const days = Math.max(0, Math.ceil(remaining / DAY));
  return { expiresAt: expiry, warning: remaining < 2 * DAY, canKeep: remaining <= 2 * DAY,
    message: remaining <= 0 ? "GitHub may delete this phone at any time unless you use it."
      : `GitHub deletes this phone in ${days} ${days === 1 ? "day" : "days"} unless you use it.` };
}

export function retentionExpiry(phone: {
  retention_at: string | null; last_stopped_at: string | null; retention_min: number;
}): string | null {
  const provider = Date.parse(phone.retention_at ?? "");
  const fallback = Date.parse(phone.last_stopped_at ?? "") + phone.retention_min * 60_000;
  const expiry = Number.isFinite(provider) ? provider : fallback;
  return Number.isFinite(expiry) ? new Date(expiry).toISOString() : null;
}
