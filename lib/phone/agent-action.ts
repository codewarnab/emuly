export type AgentAction =
  | { type: "tap"; x: number; y: number }
  | { type: "swipe"; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: "key"; key: "back" | "home" | "recent" | "other" }
  | { type: "text" }
  | { type: "command"; label: "Installing app" | "Taking screenshot" };

const KEYS: Record<string, "back" | "home" | "recent"> = {
  "4": "back", "KEYCODE_BACK": "back",
  "3": "home", "KEYCODE_HOME": "home",
  "187": "recent", "KEYCODE_APP_SWITCH": "recent",
};

const COORDINATE = /^\d+(?:\.\d+)?$/;

function coordinate(token: string | undefined): number | null {
  if (token === undefined || !COORDINATE.test(token)) return null;
  const value = Math.round(Number(token));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Parses an agent-issued adb argument list into the small, displayable action it
 * represents. Free-form payloads (typed text, paths, flags) never leave this function.
 */
export function parseAdbAction(args: string[]): AgentAction | null {
  // Arguments sometimes arrive pre-joined ("input tap 1 2"), so flatten on whitespace.
  const tokens = args.flatMap(arg => arg.split(/\s+/)).filter(token => token !== "");
  if (tokens[0] === "install" || tokens[0] === "install-multiple") return { type: "command", label: "Installing app" };
  if (tokens[0] === "shell" || tokens[0] === "exec-out") {
    if (tokens[1] === "screencap") return { type: "command", label: "Taking screenshot" };
    if (tokens[0] === "exec-out") return null;
    tokens.shift();
  }
  if (tokens[0] !== "input") return null;
  const [command, ...rest] = tokens.slice(1);
  if (command === "tap") {
    if (rest.length !== 2) return null;
    const x = coordinate(rest[0]), y = coordinate(rest[1]);
    return x === null || y === null ? null : { type: "tap", x, y };
  }
  if (command === "swipe") {
    if (rest.length !== 4 && rest.length !== 5) return null;
    const x1 = coordinate(rest[0]), y1 = coordinate(rest[1]);
    const x2 = coordinate(rest[2]), y2 = coordinate(rest[3]);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
    return { type: "swipe", from: { x: x1, y: y1 }, to: { x: x2, y: y2 } };
  }
  if (command === "keyevent") {
    if (rest.length !== 1) return null;
    return { type: "key", key: KEYS[rest[0]] ?? "other" };
  }
  if (command === "text") return rest.length > 0 ? { type: "text" } : null;
  return null;
}

/**
 * Builds the events.meta payload for an adb row: agent attribution plus the
 * displayable action. Null when there is neither, so plain rows stay lean.
 */
export function adbEventMeta(args: string[], exitCode: number, agentKeyId?: number): string | null {
  const action = exitCode === 0 ? parseAdbAction(args) : null;
  if (action === null && agentKeyId === undefined) return null;
  return JSON.stringify({
    ...(agentKeyId === undefined ? {} : { agent_key_id: agentKeyId }),
    ...(action === null ? {} : { action }),
  });
}
