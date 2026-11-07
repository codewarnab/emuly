import type { DatabaseSync } from "node:sqlite";

export type UserSettings = {
  allowance_core_hours: number;
  default_machine: string | null;
  default_idle_min: number;
  auto_stop_before_empty: boolean;
  auto_keep: boolean;
};

export class SettingsInputError extends Error {}

export function userSettings(database: DatabaseSync, userId: number): UserSettings {
  const row = database.prepare(`SELECT allowance_core_hours, default_machine, default_idle_min, auto_stop_before_empty, auto_keep
    FROM user_settings WHERE user_id = ?`).get(userId);
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
  if ("default_idle_min" in patch && patch.default_idle_min !== 30 && patch.default_idle_min !== 240) {
    throw new SettingsInputError("Choose a 30-minute or 4-hour idle timeout.");
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
    database.exec("COMMIT");
    return settings;
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}
