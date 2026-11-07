import "server-only";
import { db } from "./db";
import type { PhoneRow } from "../components/fixtures";
import type { LogRow } from "../components/log-feed";

export type Phone = {
  id: string;
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
};

const columns = `id, codespace_name, machine, state, state_detail, created_at, retention_at, idle_timeout_min,
  last_started_at, last_stopped_at, cores, retention_min,
  EXISTS(SELECT 1 FROM phone_keeps WHERE phone_id = phones.id) AS keeping`;

export function listPhones(userId: number): Phone[] {
  return db().prepare(`SELECT ${columns} FROM phones WHERE user_id = ? AND state != 'deleted'
    ORDER BY CASE WHEN state = 'running' THEN 0 WHEN state IN ('booting', 'pending', 'stopping') THEN 1 ELSE 2 END,
      COALESCE(last_started_at, last_stopped_at, created_at) DESC, id`).all(userId) as Phone[];
}

export function findPhone(userId: number, id: string): Phone | undefined {
  return db().prepare(`SELECT ${columns} FROM phones WHERE user_id = ? AND id = ? AND state != 'deleted'`)
    .get(userId, id) as Phone | undefined;
}

export function phoneCard(phone: Phone): PhoneRow {
  const state = phone.state === "pending" || phone.state === "stopping" ? "booting" : phone.state === "error" ? "needsyou" : phone.state;
  return {
    id: phone.id,
    name: phone.id,
    state: state === "running" || state === "stopped" || state === "booting" ? state : "needsyou",
    thumbDim: phone.state !== "running",
    meta: [["Slot", phone.codespace_name], ["Machine", phone.machine], [phone.state === "stopped" ? "Resume" : "Stopping", phone.state === "stopped" ? "About 15 s" : "Keeps your phone"]],
    foot: { ghost: "Backups", primary: "Open phone" },
  };
}

export function phoneEvents(userId: number, id: string): LogRow[] {
  const rows = db().prepare(`SELECT ts, kind, message FROM events WHERE user_id = ? AND phone_id = ?
    ORDER BY ts DESC, id DESC LIMIT 50`).all(userId, id) as { ts: string; kind: string; message: string }[];
  return rows.reverse().map(row => ({ time: `${row.ts.slice(11, 19)} UTC`, ok: row.kind === "step",
    parts: [{ type: "text", value: row.message }] }));
}
