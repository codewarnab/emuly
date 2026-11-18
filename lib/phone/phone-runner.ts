import "server-only";
import { asyncDb } from "../data/async-db.ts";
import { getAccessToken } from "../github/github-token.ts";
import { codespaceExec, openCodespacePort } from "../github/codespace-tunnel.ts";
import { createEmulyLinks, type RunnerPath, type AppsPath, type LinksPath, type AppsRequest, type AdbRequest, type ProxyRequest, type RecordingAction } from "./phone-link.ts";
import { agentDeviceInfo, agentDeviceTokenHash, agentDeviceTokenMatches } from "./agent-device.ts";
import { phoneObservations } from "./phone-observation.ts";
import { createActivity, androidIdleMs, ANDROID_IDLE_COMMAND } from "./last-activity.ts";

const global = globalThis as unknown as { __emulyLinks?: ReturnType<typeof createEmulyLinks>; __emulyLinksVersion?: number; __emulyActivity?: ReturnType<typeof createActivity> };
const activity = () => global.__emulyActivity ??= createActivity(asyncDb());
const links = () => {
  if (global.__emulyLinksVersion !== 9) { global.__emulyLinks = undefined; global.__emulyLinksVersion = 9; }
  return global.__emulyLinks ??= createEmulyLinks({ token: getAccessToken, tunnel: openCodespacePort,
  observations: phoneObservations(asyncDb()), activity: activity(),
  // Command completion is measured; provider idle-timer reset remains unverified.
  keepAwake: (token, codespaceName) => codespaceExec({ token, codespaceName, command: "echo emuly-awake", pty: true, timeoutMs: 90_000 }) });
};
export async function runnerRequest(userId: number, id: string, path: RunnerPath, body?: Record<string, unknown>) {
  const row = (await asyncDb().execute({ sql: `SELECT codespace_name FROM phones WHERE user_id = ? AND id = ? AND state IN ('running', 'booting', 'stopping')
    AND EXISTS(SELECT 1 FROM users WHERE id = ? AND blocked = 0)`, args: [userId, id, userId] })).rows[0] as unknown as { codespace_name: string } | undefined;
  if (!row) throw new Error("Phone is not available");
  return links().request({ userId, id, codespaceName: row.codespace_name }, path, body);
}
export function closeRunner(userId: number, id: string, codespaceName: string, reason?: string) {
  links().close({ userId, id, codespaceName }, reason);
}

export async function runnerApps(userId: number, id: string, path: AppsPath, options: AppsRequest) {
  const row = (await asyncDb().execute({ sql: `SELECT codespace_name FROM phones WHERE user_id = ? AND id = ? AND state = 'running' AND android_state = 'ready'
    AND EXISTS(SELECT 1 FROM users WHERE id = ? AND blocked = 0)`, args: [userId, id, userId] })).rows[0] as unknown as { codespace_name: string } | undefined;
  if (!row) throw new Error("Phone is not available");
  return links().apps({ userId, id, codespaceName: row.codespace_name }, path, options);
}

/** adb runs only on a phone that the runner already reports as running and ready. */
export async function runnerAdb(userId: number, id: string, input: AdbRequest) {
  const row = (await asyncDb().execute({ sql: `SELECT codespace_name FROM phones WHERE user_id = ? AND id = ? AND state = 'running' AND android_state = 'ready'
    AND EXISTS(SELECT 1 FROM users WHERE id = ? AND blocked = 0)`, args: [userId, id, userId] })).rows[0] as unknown as { codespace_name: string } | undefined;
  if (!row) throw new Error("Phone is not available");
  activity().mark({ userId, id });
  return links().adb({ userId, id, codespaceName: row.codespace_name }, input);
}

/** Screen recording calls. Recording needs Android ready; status, file and discard work while the phone runs. */
export async function runnerRecording(userId: number, id: string, action: RecordingAction, body?: Record<string, unknown>) {
  const ready = action === "start" ? "AND android_state = 'ready'" : "";
  const row = (await asyncDb().execute({ sql: `SELECT codespace_name FROM phones WHERE user_id = ? AND id = ? AND state = 'running' ${ready}
    AND EXISTS(SELECT 1 FROM users WHERE id = ? AND blocked = 0)`, args: [userId, id, userId] })).rows[0] as unknown as { codespace_name: string } | undefined;
  if (!row) throw new Error("Phone is not available");
  return links().recording({ userId, id, codespaceName: row.codespace_name }, action, body);
}

/** Ms since the last touch or key in Android. It is not an action, so it does not mark activity. Null when unknown. */
export async function runnerAndroidIdleMs(userId: number, id: string, codespaceName: string) {
  const response = await links().adb({ userId, id, codespaceName }, { args: ANDROID_IDLE_COMMAND, timeout_s: 15 });
  if (!response.ok) return null;
  const result = await response.json() as { exit_code?: number; stdout?: string };
  return result.exit_code === 0 && typeof result.stdout === "string" ? androidIdleMs(result.stdout) : null;
}

/** The runner's agent-device proxy state. Any failure is shaped as unavailable by the caller. */
export async function runnerAgentDevice(userId: number, id: string) {
  const row = (await asyncDb().execute({ sql: `SELECT codespace_name FROM phones WHERE user_id = ? AND id = ? AND state = 'running' AND android_state = 'ready'
    AND EXISTS(SELECT 1 FROM users WHERE id = ? AND blocked = 0)`, args: [userId, id, userId] })).rows[0] as unknown as { codespace_name: string } | undefined;
  if (!row) throw new Error("Phone is not available");
  const response = await links().request({ userId, id, codespaceName: row.codespace_name }, "/agent-device-info");
  const info = await response.json() as unknown;
  // Remember only the token this caller is about to receive, and never the token itself.
  const token = agentDeviceInfo(info)?.token;
  await asyncDb().execute({ sql: "UPDATE phones SET agent_device_token_hash = ? WHERE user_id = ? AND id = ?",
    args: [token ? agentDeviceTokenHash(token) : null, userId, id] });
  return info;
}

/** The agent-device proxy authenticates with its own token, so the phone is found by id alone. */
export async function runnerProxy(id: string, token: string, path: string, init: ProxyRequest,
  onResponse?: (userId: number, status: number) => Promise<void>) {
  const row = (await asyncDb().execute({ sql: `SELECT p.user_id AS user_id, p.codespace_name AS codespace_name,
    p.agent_device_token_hash AS token_hash
    FROM phones p JOIN users u ON u.id = p.user_id
    WHERE p.id = ? AND p.state = 'running' AND p.android_state = 'ready' AND u.blocked = 0`,
    args: [id] })).rows[0] as unknown as { user_id: number; codespace_name: string; token_hash: string | null } | undefined;
  if (!row || !agentDeviceTokenMatches(row.token_hash, token)) throw new Error("Phone is not available");
  const response = await links().proxy({ userId: row.user_id, id, codespaceName: row.codespace_name }, path, init);
  // A rotated token invalidates the digest; drop it so the agent fetches a fresh one.
  if (response.status === 401) await asyncDb().execute({ sql: `UPDATE phones SET agent_device_token_hash = NULL
    WHERE id = ? AND agent_device_token_hash = ?`, args: [id, row.token_hash] }).catch(() => {});
  if (onResponse) await onResponse(row.user_id, response.status).catch(() => {});
  return response;
}

export async function runnerStream(userId: number, id: string, sessionId: string) {
  const row = (await asyncDb().execute({ sql: `SELECT codespace_name FROM phones WHERE user_id = ? AND id = ?
    AND state = 'running' AND android_state = 'ready'
    AND EXISTS(SELECT 1 FROM users WHERE id = ? AND blocked = 0)
    AND EXISTS(SELECT 1 FROM sessions WHERE id = ? AND user_id = ? AND expires_at > ?)`, args: [userId, id, userId, sessionId, userId, new Date().toISOString()] })).rows[0] as unknown as { codespace_name: string } | undefined;
  if (!row) throw new Error("Phone is not available");
  return links().stream({ userId, id, codespaceName: row.codespace_name });
}

async function runningCodespace(userId: number, id: string) {
  const row = (await asyncDb().execute({ sql: `SELECT codespace_name FROM phones WHERE user_id = ? AND id = ? AND state = 'running'
    AND EXISTS(SELECT 1 FROM users WHERE id = ? AND blocked = 0)`, args: [userId, id, userId] })).rows[0] as unknown as { codespace_name: string } | undefined;
  if (!row) throw new Error("Phone is not available");
  return row.codespace_name;
}

/** Link and net-check calls to the runner. Links work while Android boots; net-check needs Android. */
export async function runnerLinks(userId: number, id: string, path: LinksPath, body?: Record<string, unknown>) {
  const codespaceName = await runningCodespace(userId, id);
  return { codespaceName, response: await links().links({ userId, id, codespaceName }, path, body) };
}

/** The runner end of a Route B relay. */
export async function runnerRelay(userId: number, id: string, ports: number[]) {
  const codespaceName = await runningCodespace(userId, id);
  return links().relay({ userId, id, codespaceName }, ports);
}
