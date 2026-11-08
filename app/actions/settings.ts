"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../lib/auth/auth";
import { asyncDb } from "../../lib/data/async-db";
import { redirect } from "next/navigation";
import { choosePlan, saveHoursSetting, type HoursField } from "../../lib/data/settings";
import { acknowledgeAutoStops } from "../../lib/shared/hours";
import { saveStreamQuality } from "../../lib/shared/display-settings";

export async function saveDisplayQuality(value: unknown) {
  const user = await requireUser();
  try {
    const result = await saveStreamQuality(asyncDb(), user.id, value);
    if (result.ok) revalidatePath("/app", "layout");
    return result;
  } catch { return { ok: false, message: "Settings could not be saved. Try again." }; }
}

export async function saveHoursField(field: HoursField, value: unknown) {
  const user = await requireUser();
  const result = await saveHoursSetting(asyncDb(), user.id, field, value);
  if (result.ok) {
    revalidatePath("/app");
    revalidatePath("/app/settings/hours");
  }
  return result;
}

export async function savePlan(form: FormData) {
  const user = await requireUser();
  const plan = form.get("plan");
  if (plan !== "free" && plan !== "pro") return;
  await choosePlan(asyncDb(), user.id, plan);
  revalidatePath("/app");
  redirect("/app");
}

export async function dismissAutoStops(ids: number[]) {
  const user = await requireUser();
  if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) return;
  await acknowledgeAutoStops(asyncDb(), user.id, ids);
}
