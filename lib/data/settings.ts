import type { Client } from "@libsql/client";
import { transaction, type DatabaseQueries } from "./async-database.ts";
import { IDLE_MAX, IDLE_MIN, validIdle } from "../shared/idle.ts";

export type UserSettings = {
  allowance_core_hours: number;
  default_machine: string | null;
  default_idle_min: number;
  auto_stop_before_empty: boolean;
  auto_keep: boolean;
};

export class SettingsInputError extends Error {}

export type HoursField = "idle" | "autoStop" | "autoKeep" | "plan";

/** Persist one Hours control. Runtime validation also protects Server Action callers. */
export async function saveHoursSetting(database: Client, userId: number, field: unknown, value: unknown) {
  try {
    switch (field) {
      case "idle": await updateSettings(database, userId, { default_idle_min: value }); break;
      case "autoStop": await updateSettings(database, userId, { auto_stop_before_empty: value }); break;
      case "autoKeep": await updateSettings(database, userId, { auto_keep: value }); break;
      case "plan":
        if (value === "free" || value === "pro") await choosePlan(database, userId, value);
        else if (typeof value === "number") await updateSettings(database, userId, { allowance_core_hours: value });
        else throw new SettingsInputError("Choose Free, Pro, or enter your monthly core-hours.");
        break;
      default: throw new SettingsInputError("Choose a valid Hours setting.");
    }
    return { ok: true, message: "Saved" };
  } catch (error) {
    return { ok: false, message: error instanceof SettingsInputError ? error.message : "Settings could not be saved. Try again." };
  }
}

/** The plan the user told us in onboarding. null = not asked yet. */
export async function chosenPlan(database: DatabaseQueries, userId: number): Promise<"free" | "pro" | null> {
  const row = (await database.execute({ sql: "SELECT plan_name FROM billing_settings WHERE user_id = ?", args: [userId] })).rows[0];
  return row?.plan_name === "free" || row?.plan_name === "pro" ? row.plan_name : null;
}

/** Save the plan and drop any manual allowance so the plan's allowance applies. */
export async function choosePlan(database: DatabaseQueries, userId: number, plan: "free" | "pro") {
  await database.execute({ sql: `INSERT INTO billing_settings (user_id, plan_name, allowance_override) VALUES (?, ?, NULL)
    ON CONFLICT(user_id) DO UPDATE SET plan_name = excluded.plan_name, allowance_override = NULL`, args: [userId, plan] });
}

export async function clearAllowanceOverride(database: DatabaseQueries, userId: number) {
  await database.execute({ sql: "UPDATE billing_settings SET allowance_override = NULL WHERE user_id = ?", args: [userId] });
}

export async function userSettings(database: DatabaseQueries, userId: number): Promise<UserSettings> {
  const row = (await database.execute({ sql: `SELECT COALESCE(b.allowance_override,
      CASE WHEN b.plan_name = 'pro' THEN 180 ELSE 120 END) AS allowance_core_hours,
      s.default_machine, COALESCE(s.default_idle_min, 30) AS default_idle_min,
      COALESCE(s.auto_stop_before_empty, 0) AS auto_stop_before_empty, COALESCE(s.auto_keep, 0) AS auto_keep
    FROM users u LEFT JOIN user_settings s ON s.user_id = u.id
    LEFT JOIN billing_settings b ON b.user_id = u.id WHERE u.id = ?`, args: [userId] })).rows[0];
  return row ? {
    allowance_core_hours: Number(row.allowance_core_hours), default_machine: row.default_machine as string | null,
    default_idle_min: Number(row.default_idle_min), auto_stop_before_empty: row.auto_stop_before_empty === 1,
    auto_keep: row.auto_keep === 1,
  } : { allowance_core_hours: 120, default_machine: null, default_idle_min: 30, auto_stop_before_empty: false, auto_keep: false };
}

/** Partial updates preserve other settings. Validate the whole patch before writing. */
export async function updateSettings(database: Client, userId: number, input: unknown): Promise<UserSettings> {
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
  return transaction(database, async queries => {
    const settings = { ...await userSettings(queries, userId), ...patch } as UserSettings;
    await queries.execute({ sql: `INSERT INTO user_settings
      (user_id, allowance_core_hours, default_machine, default_idle_min, auto_stop_before_empty, auto_keep) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET allowance_core_hours = excluded.allowance_core_hours,
      default_machine = excluded.default_machine, default_idle_min = excluded.default_idle_min,
      auto_stop_before_empty = excluded.auto_stop_before_empty, auto_keep = excluded.auto_keep`, args: [userId, settings.allowance_core_hours, settings.default_machine, settings.default_idle_min,
        Number(settings.auto_stop_before_empty), Number(settings.auto_keep)] });
    if ("allowance_core_hours" in patch) {
      await queries.execute({ sql: `INSERT INTO billing_settings (user_id, allowance_override) VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET allowance_override = excluded.allowance_override`, args: [userId, settings.allowance_core_hours] });
    }
    return settings;
  });
}
