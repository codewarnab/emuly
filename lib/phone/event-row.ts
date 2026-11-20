import type { LogRow } from "@/components/ui/log-feed";
import { shortMessage } from "../shared/short-message.ts";
import { phoneEventMessage } from "./phone-status.ts";

export type StoredEvent = { ts: string; kind: string; message: string; meta: string | null };

type Meta = { agent_key_id?: unknown; action?: unknown; note?: unknown; command?: unknown };

function parseMeta(meta: string | null): Meta {
  if (!meta) return {};
  try {
    const value = JSON.parse(meta) as unknown;
    return value !== null && typeof value === "object" ? value as Meta : {};
  } catch { return {}; }
}

const AGENT_SUFFIX = / \[agent key \d+\]$/;

/** Plain words for agent-device commands. The CLI cannot send X-Emuly-Note, so its rows use these. */
const AGENT_DEVICE_LABELS: Record<string, string> = {
  open: "Opened an app", close: "Closed the app", connect: "Connected to the phone", disconnect: "Disconnected from the phone",
  snapshot: "Read the screen", diff: "Checked what changed on the screen", screenshot: "Took a screenshot",
  press: "Pressed an element", click: "Pressed an element", tap: "Tapped the screen", longpress: "Long-pressed an element",
  fill: "Filled a field", type: "Typed text", focus: "Focused a field",
  scroll: "Scrolled", swipe: "Swiped", back: "Pressed Back", home: "Pressed Home",
  wait: "Waited for the screen", find: "Looked for an element", get: "Read an element", is: "Checked an element",
  route: "Changed a network route", logs: "Read the logs", appstate: "Checked the app state",
};

/** A short label for a parsed adb action. Null when the action is unknown. */
function actionLabel(action: unknown): string | null {
  if (action === null || typeof action !== "object") return null;
  const value = action as { type?: unknown; x?: unknown; y?: unknown; from?: { x?: unknown; y?: unknown }; to?: { x?: unknown; y?: unknown }; key?: unknown; label?: unknown };
  switch (value.type) {
    case "tap": return `Tap at (${value.x}, ${value.y})`;
    case "swipe": return `Swipe from (${value.from?.x}, ${value.from?.y}) to (${value.to?.x}, ${value.to?.y})`;
    case "key": return value.key === "back" ? "Press Back" : value.key === "home" ? "Press Home" : value.key === "recent" ? "Open recent apps" : "Press a key";
    case "text": return "Type text";
    case "command": return typeof value.label === "string" ? value.label : null;
    default: return null;
  }
}

/**
 * Maps a stored event to a feed row. An agent row shows the agent's note, or a label made from the
 * command when there is no note. `detail` is the stored command, shown when someone clicks the row.
 * The stored command is already trimmed (adb keeps 3 args), so typed text and file contents never show.
 */
export function eventRow(event: StoredEvent): LogRow {
  const base = { time: `${event.ts.slice(11, 19)} UTC`, at: event.ts, ok: event.kind === "step", error: event.kind === "error" };
  const meta = parseMeta(event.meta);
  const agent = typeof meta.agent_key_id === "number";
  const note = typeof meta.note === "string" && meta.note ? meta.note : null;
  if (event.kind === "agent_device") {
    const match = /^agent-device (\S+)( \(HTTP \d+\))?$/.exec(event.message);
    const label = match ? AGENT_DEVICE_LABELS[match[1].toLowerCase()] : undefined;
    const text = label ? `${label}${match?.[2] ?? ""}` : event.message;
    return { ...base, error: base.error || Boolean(match?.[2] && Number(match[2].slice(7, -1)) >= 400), agent: true,
      parts: [{ type: "text", value: text }], ...(text !== event.message ? { detail: event.message } : {}) };
  }
  if (!agent && !note) {
    return { ...base, parts: [{ type: "text", value: phoneEventMessage(event.message.length > 100 ? shortMessage(event.message) : event.message) }] };
  }
  const stored = event.message.replace(AGENT_SUFFIX, "");
  const failed = / \((exit -?\d+|HTTP \d+)\)$/.test(stored);
  let command: string;
  let label: string;
  if (event.kind === "agent") {
    command = typeof meta.command === "string" ? meta.command : stored;
    label = stored;
  } else {
    const action = actionLabel(meta.action);
    command = stored;
    label = action ?? stored;
  }
  const text = note ?? label;
  return { ...base, error: base.error || failed, agent, parts: [{ type: "text", value: text }],
    ...(command !== text ? { detail: command } : {}) };
}
