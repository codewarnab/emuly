import type { DatabaseSync } from "node:sqlite";
import { IDLE_MAX, IDLE_MIN, validIdle } from "./idle.ts";

export type UserSettings = {
  allowance_core_hours: number;
  default_machine: string | null;
  default_idle_min: number;
  auto_stop_before_empty: boolean;
  auto_keep: boolean;
};

export class SettingsInputError extends Error {}

/** The plan the user told us in onboarding. null = not asked yet. */
export function chosenPlan(database: DatabaseSync, userId: number): "free" | "pro" | null {
  const row = database.prepare("SELECT plan_name FROM billing_settings WHERE user_id = ?").get(userId);
  return row?.plan_name === "free" || row?.plan_name === "pro" ? row.plan_name : null;
}

/** Save the plan and drop any manual allowance so the plan's allowance applies. */
export function choosePlan(database: DatabaseSync, userId: number, plan: "free" | "pro") {
  database.prepare(`INSERT INTO billing_settings (user_id, plan_name, allowance_override) VALUES (?, ?, NULL)
    ON CONFLICT(user_id) DO UPDATE SET plan_name = excluded.plan_name, allowance_override = NULL`).run(userId, plan);
}

export function clearAllowanceOverride(database: DatabaseSync, userId: number) {
  database.prepare("UPDATE billing_settings SET allowance_override = NULL WHERE user_id = ?").run(userId);
}

export function userSettings(database: DatabaseSync, userId: number): UserSettings {
  const row = database.prepare(`SELECT COALESCE(b.allowance_override,
      CASE WHEN b.plan_name = 'pro' THEN 180 ELSE 120 END) AS allowance_core_hours,
      s.default_machine, COALESCE(s.default_idle_min, 30) AS default_idle_min,
      COALESCE(s.auto_stop_before_empty, 0) AS auto_stop_before_empty, COALESCE(s.auto_keep, 0) AS auto_keep
    FROM users u LEFT JOIN user_settings s ON s.user_id = u.id
    LEFT JOIN billing_settings b ON b.user_id = u.id WHERE u.id = ?`).get(userId);
  return row ? {
    allowance_core_hours: Number(row.allowance_core_hours), default_machine: row.default_machine as string | null,
    default_idle_min: Number(row.default_idle_min), auto_stop_before_empty: row.auto_stop_before_empty === 1,
    auto_keep: row.auto_keep === 1,
  } : { allowance_core_hours: 120, default_machine: null, default_idle_min: 30, auto_stop_before_empty: false, auto_keep: false };
}

/** Partial updates preserve other settings. Validate the whole patch before writing. */
export function updateSettings(database: DatabaseSync, userId: number, input: unknown): UserSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SettingsInputError("Expected a JSON object.");
  const patch = input as Record<string, unknown>;
  const keys = ["allowance_core_hours", "default_machine", "default_idle_min", "auto_stop_before_empty", "auto_keep"];
  if (!Object.keys(patch).length || Object.keys(patch).some(key => !keys.includes(key))) {
    throw new SettingsInputError("Choose an allowance, machine, idle timeout, or auto-stop setting.");
  }
  if ("allowance_core_hours" in patch && (typeof patch.allowance_core_hours !== "number"
    || !Number.isFinite(patch.allowance_core_hours) || patch.allowance_core_hours < 0)) {
    throw new SettingsInputError("Enter a non-negative allowance in core-hours.");
  }
  if ("default_machine" in patch && patch.default_machine !== null
    && (typeof patch.default_machine !== "string" || !/^[\w-]{1,100}$/.test(patch.default_machine))) {
    throw new SettingsInputError("Choose a valid machine.");
  }
  if ("default_idle_min" in patch && !validIdle(patch.default_idle_min)) {
    throw new SettingsInputError(`Choose an idle timeout from ${IDLE_MIN} to ${IDLE_MAX} minutes.`);
  }
  if ("auto_stop_before_empty" in patch && typeof patch.auto_stop_before_empty !== "boolean") {
    throw new SettingsInputError("Auto-stop must be true or false.");
  }
  if ("auto_keep" in patch && typeof patch.auto_keep !== "boolean") {
    throw new SettingsInputError("Auto-keep must be true or false.");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const settings = { ...userSettings(database, userId), ...patch } as UserSettings;
    database.prepare(`INSERT INTO user_settings
      (user_id, allowance_core_hours, default_machine, default_idle_min, auto_stop_before_empty, auto_keep) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET allowance_core_hours = excluded.allowance_core_hours,
      default_machine = excluded.default_machine, default_idle_min = excluded.default_idle_min,
      auto_stop_before_empty = excluded.auto_stop_before_empty, auto_keep = excluded.auto_keep`)
      .run(userId, settings.allowance_core_hours, settings.default_machine, settings.default_idle_min,
        Number(settings.auto_stop_before_empty), Number(settings.auto_keep));
    if ("allowance_core_hours" in patch) {
      database.prepare(`INSERT INTO billing_settings (user_id, allowance_override) VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET allowance_override = excluded.allowance_override`)
        .run(userId, settings.allowance_core_hours);
    }
    database.exec("COMMIT");
    return settings;
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}
