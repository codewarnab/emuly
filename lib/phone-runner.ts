import "server-only";
import { db } from "./db.ts";
import { getAccessToken } from "./github-token.ts";
import { codespaceExec, openCodespacePort } from "./codespace-tunnel.ts";
import { createPhoneLinks, type RunnerPath } from "./phone-link.ts";

const global = globalThis as unknown as { __phoneLinks?: ReturnType<typeof createPhoneLinks> };
const links = () => global.__phoneLinks ??= createPhoneLinks({ token: getAccessToken, tunnel: openCodespacePort,
  // GitHub counts terminal output, not port traffic, as activity. So a watched phone does not idle-stop.
  keepAwake: (token, codespaceName) => codespaceExec({ token, codespaceName, command: "echo phonelink-awake", pty: true, timeoutMs: 90_000 }) });
export async function runnerRequest(userId: number, id: string, path: RunnerPath, body?: Record<string, unknown>) {
  const row = db().prepare(`SELECT codespace_name FROM phones WHERE user_id = ? AND id = ? AND state IN ('running', 'booting', 'stopping')
    AND EXISTS(SELECT 1 FROM users WHERE id = ? AND blocked = 0)`).get(userId, id, userId) as { codespace_name: string } | undefined;
  if (!row) throw new Error("Phone is not available");
  return links().request({ userId, id, codespaceName: row.codespace_name }, path, body);
}
export function closeRunner(userId: number, id: string, codespaceName: string) {
  links().close({ userId, id, codespaceName });
}

export async function runnerStream(userId: number, id: string, sessionId: string) {
  const row = db().prepare(`SELECT codespace_name FROM phones WHERE user_id = ? AND id = ?
    AND state = 'running' AND android_state = 'ready'
    AND EXISTS(SELECT 1 FROM users WHERE id = ? AND blocked = 0)
    AND EXISTS(SELECT 1 FROM sessions WHERE id = ? AND user_id = ? AND expires_at > ?)`).get(userId, id, userId, sessionId, userId, new Date().toISOString()) as { codespace_name: string } | undefined;
  if (!row) throw new Error("Phone is not available");
  return links().stream({ userId, id, codespaceName: row.codespace_name });
}
