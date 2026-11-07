export type KeyInput = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };
export function shortcutKey(event: KeyInput, editing: boolean): string | null {
  if (event.altKey) return null;
  if (event.key.toLowerCase() === "k" && event.metaKey !== event.ctrlKey && !event.shiftKey) return "command";
  if (editing || event.metaKey || event.ctrlKey) return null;
  if (event.key === "?") return "?";
  return event.shiftKey ? null : event.key.toLowerCase();
}
export function filterCommands<T extends { label: string; keywords?: string }>(items: T[], query: string): T[] {
  const words = query.toLowerCase().trim().split(/\s+/);
  return items.filter(item => words.every(word => `${item.label} ${item.keywords ?? ""}`.toLowerCase().includes(word)));
}
export const PHONE_TABS = ["log", "apps", "backups", "danger"] as const;
export function phoneTabHref(id: string, tab: string) {
  return `/app/phones/${encodeURIComponent(id)}?tab=${tab}`;
}
