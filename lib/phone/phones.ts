import "server-only";
import { shortMessage } from "../shared/short-message.ts";
import { phoneName } from "../shared/phone-name.ts";
import { phoneStatus, phoneEventMessage } from "./phone-status.ts";
import { db } from "../data/db";
import type { PhoneRow } from "@/lib/shared/fixtures";
import type { LogRow } from "@/components/ui/log-feed";

export type Phone = {
  id: string;
  /** Friendly name for display only. Never use it in URLs or API calls. */
  name: string;
  codespace_name: string;
  machine: string;
  state: string;
  state_detail: string | null;
  created_at: string;
  retention_at: string | null;
  idle_timeout_min: number;
  last_started_at: string | null;
  last_stopped_at: string | null;
  cores: number | null;
  retention_min: number;
  keeping: number;
  android_state: string;
  android_started_at: string | null;
  android_error: string | null;
};

const columns = `id, codespace_name, machine, state, state_detail, created_at, retention_at, idle_timeout_min,
  last_started_at, last_stopped_at, cores, retention_min, android_state, android_started_at, android_error,
  EXISTS(SELECT 1 FROM phone_keeps WHERE phone_id = phones.id) AS keeping`;

export function listPhones(userId: number): Phone[] {
  const rows = db().prepare(`SELECT ${columns} FROM phones WHERE user_id = ? AND state != 'deleted'
    ORDER BY CASE WHEN state = 'running' THEN 0 WHEN state IN ('booting', 'pending', 'stopping') THEN 1 ELSE 2 END,
      COALESCE(last_started_at, last_stopped_at, created_at) DESC, id`).all(userId) as unknown as Omit<Phone, "name">[];
  return rows.map(row => ({ ...row, name: phoneName(row.id) }));
}

export function findPhone(userId: number, id: string): Phone | undefined {
  const row = db().prepare(`SELECT ${columns} FROM phones WHERE user_id = ? AND id = ? AND state != 'deleted'`)
    .get(userId, id) as Omit<Phone, "name"> | undefined;
  return row && { ...row, name: phoneName(row.id) };
}

export function phoneCard(phone: Phone): PhoneRow {
  const status = phoneStatus(phone);
  return {
    id: phone.id,
    name: phone.name,
    state: status.kind,
    statusLabel: status.label,
    thumbDim: status.kind !== "running",
    screenReady: status.kind === "running",
    meta: [
      ["Status", status.title],
      ["Machine", "4-core · 16 GB"],
    ],
    foot: { ghost: "Backups", primary: "Open phone" },
  };
}

export function phoneEvents(userId: number, id: string): LogRow[] {
  const rows = db().prepare(`SELECT ts, kind, message FROM events WHERE user_id = ? AND phone_id = ?
    ORDER BY ts DESC, id DESC LIMIT 50`).all(userId, id) as { ts: string; kind: string; message: string }[];
  return rows.map(row => ({ time: `${row.ts.slice(11, 19)} UTC`, at: row.ts, ok: row.kind === "step", error: row.kind === "error",
    parts: [{ type: "text", value: phoneEventMessage(row.message.length > 100 ? shortMessage(row.message) : row.message) }] }));
}
