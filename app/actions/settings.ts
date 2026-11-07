"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../lib/auth";
import { db } from "../../lib/db";
import { SettingsInputError, updateSettings } from "../../lib/settings";
import { acknowledgeAutoStops } from "../../lib/hours";

export async function saveHours(_previous: { message: string }, form: FormData) {
  const user = await requireUser();
  const choice = form.get("allowance");
  const value = choice === "custom" ? form.get("customAllowance") : choice;
  if (!["120", "180", "custom"].includes(String(choice)) || typeof value !== "string" || !value.trim()) {
    return { message: "Choose Free, Pro, or a custom allowance." };
  }
  try {
    updateSettings(db(), user.id, {
      allowance_core_hours: Number(value), default_machine: form.get("machine") || null,
      default_idle_min: Number(form.get("idle")), auto_stop_before_empty: form.get("autoStop") === "on",
      auto_keep: form.get("autoKeep") === "on",
    });
  } catch (error) {
    return { message: error instanceof SettingsInputError ? error.message : "Settings could not be saved. Try again." };
  }
  revalidatePath("/app");
  revalidatePath("/app/settings/hours");
  return { message: "Hours settings saved. If about 30 minutes or less remain, auto-stop runs on the next tick when enabled." };
}

export async function dismissAutoStops(ids: number[]) {
  const user = await requireUser();
  if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) return;
  acknowledgeAutoStops(db(), user.id, ids);
}
