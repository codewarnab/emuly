import "server-only";
import { asyncDb } from "../data/async-db.ts";
import { getAccessToken } from "../github/github-token.ts";
import { codespaceExec, openCodespacePort } from "../github/codespace-tunnel.ts";
import { createPhoneLinks, type RunnerPath, type AppsPath, type AppsRequest } from "./phone-link.ts";
import { phoneObservations } from "./phone-observation.ts";

const global = globalThis as unknown as { __phoneLinks?: ReturnType<typeof createPhoneLinks>; __phoneLinksVersion?: number };
const links = () => {
  if (global.__phoneLinksVersion !== 5) { global.__phoneLinks = undefined; global.__phoneLinksVersion = 5; }
  return global.__phoneLinks ??= createPhoneLinks({ token: getAccessToken, tunnel: openCodespacePort,
  observations: phoneObservations(asyncDb()),
  // Command completion is measured; provider idle-timer reset remains unverified.
  keepAwake: (token, codespaceName) => codespaceExec({ token, codespaceName, command: "echo phonelink-awake", pty: true, timeoutMs: 90_000 }) });
};
export async function runnerRequest(userId: number, id: string, path: RunnerPath, body?: Record<string, unknown>) {
  const row = (await asyncDb().execute({ sql: `SELECT codespace_name FROM phones WHERE user_id = ? AND id = ? AND state IN ('running', 'booting', 'stopping')
    AND EXISTS(SELECT 1 FROM users WHERE id = ? AND blocked = 0)`, args: [userId, id, userId] })).rows[0] as unknown as { codespace_name: string } | undefined;
  if (!row) throw new Error("Phone is not available");
  return links().request({ userId, id, codespaceName: row.codespace_name }, path, body);
}
export function closeRunner(userId: number, id: string, codespaceName: string) {
  links().close({ userId, id, codespaceName });
}

export async function runnerApps(userId: number, id: string, path: AppsPath, options: AppsRequest) {
  const row = (await asyncDb().execute({ sql: `SELECT codespace_name FROM phones WHERE user_id = ? AND id = ? AND state = 'running' AND android_state = 'ready'
    AND EXISTS(SELECT 1 FROM users WHERE id = ? AND blocked = 0)`, args: [userId, id, userId] })).rows[0] as unknown as { codespace_name: string } | undefined;
  if (!row) throw new Error("Phone is not available");
  return links().apps({ userId, id, codespaceName: row.codespace_name }, path, options);
}

export async function runnerStream(userId: number, id: string, sessionId: string) {
  const row = (await asyncDb().execute({ sql: `SELECT codespace_name FROM phones WHERE user_id = ? AND id = ?
    AND state = 'running' AND android_state = 'ready'
    AND EXISTS(SELECT 1 FROM users WHERE id = ? AND blocked = 0)
    AND EXISTS(SELECT 1 FROM sessions WHERE id = ? AND user_id = ? AND expires_at > ?)`, args: [userId, id, userId, sessionId, userId, new Date().toISOString()] })).rows[0] as unknown as { codespace_name: string } | undefined;
  if (!row) throw new Error("Phone is not available");
  return links().stream({ userId, id, codespaceName: row.codespace_name });
}
