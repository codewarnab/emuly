"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../lib/auth";
import { db } from "../../lib/db";
import { redirect } from "next/navigation";
import { choosePlan, saveHoursSetting, type HoursField } from "../../lib/settings";
import { acknowledgeAutoStops } from "../../lib/hours";

export async function saveHoursField(field: HoursField, value: unknown) {
  const user = await requireUser();
  const result = saveHoursSetting(db(), user.id, field, value);
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
  choosePlan(db(), user.id, plan);
  revalidatePath("/app");
  redirect("/app");
}

export async function dismissAutoStops(ids: number[]) {
  const user = await requireUser();
  if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) return;
  acknowledgeAutoStops(db(), user.id, ids);
}
