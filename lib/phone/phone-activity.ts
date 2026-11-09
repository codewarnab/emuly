import "server-only";
import { asyncDb } from "../data/async-db.ts";
import { redact } from "./phone-mutations.ts";

/** Activity rows show what the agent asked adb to do without storing tapped text or file contents. */
export async function recordPhoneAdb({ userId, phoneId, args, agentKeyId, exitCode, at = Date.now() }: {
  userId: number; phoneId: string; args: string[]; agentKeyId?: number; exitCode: number; at?: number;
}) {
  const command = args.slice(0, 3).join(" ").slice(0, 160);
  const suffix = agentKeyId === undefined ? "" : ` [agent key ${agentKeyId}]`;
  const message = `adb ${command || "request"}${exitCode === 0 ? "" : ` (exit ${exitCode})`}${suffix}`;
  await asyncDb().execute({ sql: "INSERT INTO events (user_id, phone_id, ts, kind, message, meta) VALUES (?, ?, ?, 'adb', ?, ?)",
    args: [userId, phoneId, new Date(at).toISOString(), redact(message),
      agentKeyId === undefined ? null : JSON.stringify({ agent_key_id: agentKeyId })] });
}
