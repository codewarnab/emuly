/** GitHub accepts an idle timeout from 5 to 240 minutes for a codespace. */
export const IDLE_MIN = 5;
export const IDLE_MAX = 240;
/**
 * The idle timeout Emuly sends to GitHub for each new codespace. GitHub counts only editor, terminal and
 * SSH input as activity, not API calls through a forwarded port. So Emuly asks for the maximum, and its own
 * idle check (lib/phone/idle-stop.ts) stops the phone after the user's idle_timeout_min.
 * https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces
 */
export const PROVIDER_IDLE_MIN = IDLE_MAX;
export const IDLE_PRESETS = [15, 30, 60, 120, 240] as const;

export function validIdle(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= IDLE_MIN && value <= IDLE_MAX;
}

/** Reads a form value such as "30" and returns minutes, or null when it is not valid. */
export function parseIdle(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{1,3}$/.test(value.trim())) return null;
  const minutes = Number(value);
  return validIdle(minutes) ? minutes : null;
}

export function idleLabel(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} h` : `${Math.floor(hours)} h ${minutes % 60} min`;
}
