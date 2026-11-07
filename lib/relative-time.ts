/** "just now", "6 min ago", "2 h ago", "3 d ago" for a past ISO time. */
export function timeAgo(at: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

/** A gap between two moments, such as "4s", "6m 20s" or "1h 5m". */
export function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The full UTC time, for a tooltip. */
export function utcLabel(at: string) {
  return `${at.slice(0, 10)} ${at.slice(11, 19)} UTC`;
}
