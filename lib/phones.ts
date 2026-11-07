import "server-only";
import { db } from "./db";
import type { PhoneRow } from "../components/fixtures";

export type Phone = {
  id: string;
  codespace_name: string;
  machine: string;
  state: string;
  state_detail: string | null;
  created_at: string;
  retention_at: string | null;
};

const columns = "id, codespace_name, machine, state, state_detail, created_at, retention_at";

export function listPhones(userId: number): Phone[] {
  return db().prepare(`SELECT ${columns} FROM phones WHERE user_id = ? AND state != 'deleted'
    ORDER BY created_at, id`).all(userId) as Phone[];
}

export function findPhone(userId: number, id: string): Phone | undefined {
  return db().prepare(`SELECT ${columns} FROM phones WHERE user_id = ? AND id = ? AND state != 'deleted'`)
    .get(userId, id) as Phone | undefined;
}

export function phoneCard(phone: Phone): PhoneRow {
  const state = phone.state === "pending" ? "booting" : phone.state === "error" ? "needsyou" : phone.state;
  return {
    id: phone.id,
    name: phone.id,
    state: state === "running" || state === "stopped" || state === "booting" ? state : "needsyou",
    thumbDim: phone.state !== "running",
    meta: [["Slot", phone.codespace_name], ["Machine", phone.machine], [phone.state === "stopped" ? "Resume" : "Stopping", phone.state === "stopped" ? "About 15 s" : "Keeps your phone"]],
    foot: { ghost: "Backups", primary: "Open phone" },
  };
}
