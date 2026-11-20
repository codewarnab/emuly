import "server-only";
import { asyncDb } from "../data/async-db.ts";
import { adbEventMeta } from "./agent-action.ts";
import { redact } from "./phone-mutations.ts";

/** Activity rows show what the agent asked adb to do without storing tapped text or file contents. */
export async function recordPhoneAdb({ userId, phoneId, args, agentKeyId, exitCode, note, at = Date.now() }: {
  userId: number; phoneId: string; args: string[]; agentKeyId?: number; exitCode: number; note?: string | null; at?: number;
}) {
  const command = args.slice(0, 3).join(" ").slice(0, 160);
  const suffix = agentKeyId === undefined ? "" : ` [agent key ${agentKeyId}]`;
  const message = `adb ${command || "request"}${exitCode === 0 ? "" : ` (exit ${exitCode})`}${suffix}`;
  await asyncDb().execute({ sql: "INSERT INTO events (user_id, phone_id, ts, kind, message, meta) VALUES (?, ?, ?, 'adb', ?, ?)",
    args: [userId, phoneId, new Date(at).toISOString(), redact(message), adbEventMeta(args, exitCode, agentKeyId, note)] });
}

/** One row per agent-device call. Only the command name is stored, never refs, selectors or typed text. */
export async function recordPhoneAgentDevice({ userId, phoneId, command, status, at = Date.now() }: {
  userId: number; phoneId: string; command: string | null; status: number; at?: number;
}) {
  const message = `agent-device ${command ?? "request"}${status < 400 ? "" : ` (HTTP ${status})`}`;
  await asyncDb().execute({ sql: "INSERT INTO events (user_id, phone_id, ts, kind, message) VALUES (?, ?, ?, 'agent_device', ?)",
    args: [userId, phoneId, new Date(at).toISOString(), redact(message)] });
}

/** One row per agent call that is not adb (screenshot, recording). The label says what it did; meta keeps the call. */
export async function recordPhoneAgentAction({ userId, phoneId, agentKeyId, label, command, note, at = Date.now() }: {
  userId: number; phoneId: string; agentKeyId: number; label: string; command: string; note: string | null; at?: number;
}) {
  const meta = JSON.stringify({ agent_key_id: agentKeyId, command, ...(note ? { note } : {}) });
  await asyncDb().execute({ sql: "INSERT INTO events (user_id, phone_id, ts, kind, message, meta) VALUES (?, ?, ?, 'agent', ?, ?)",
    args: [userId, phoneId, new Date(at).toISOString(), redact(`${label} [agent key ${agentKeyId}]`), meta] });
}
