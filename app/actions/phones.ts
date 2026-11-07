"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../lib/auth";
import { phoneControl, templateRepository } from "../../lib/phone-control";
import { PHONE_MACHINE } from "../../lib/github";
import { IDLE_MAX, IDLE_MIN, parseIdle } from "../../lib/idle";
import { GitHubError } from "../../lib/github";
import { PhoneInputError, redact } from "../../lib/phone-mutations";
import { RateLimitError } from "../../lib/rate-limit";
import { db } from "../../lib/db";
import { saveAllowance, userSettings } from "../../lib/usage";
import { clearAllowanceOverride } from "../../lib/settings";

type MutationResult = { message: string; phoneId?: string };

export async function mutatePhone(_previous: MutationResult, form: FormData): Promise<MutationResult> {
  const user = await requireUser();
  const operation = form.get("operation");
  let id: string | undefined;
  let message: string;
  try {
    if (operation === "stopAll") {
      const result = await phoneControl().stopAll(user.id);
      message = result.errors.length
        ? `Stop accepted for ${result.stopped} phones. ${result.errors[0]}`
        : `Stopped ${result.stopped} phones. Your codespaces keep them.`;
    } else if (operation === "create") {
      const idle = form.get("idleTimeoutMin");
      const minutes = parseIdle(idle);
      if (minutes === null) throw new PhoneInputError(`Enter an idle timeout from ${IDLE_MIN} to ${IDLE_MAX} minutes.`);
      id = await phoneControl().create(user.id, {
        ...templateRepository(), machine: PHONE_MACHINE.name, idleTimeoutMin: minutes,
      });
      message = "Phone created. GitHub is preparing the codespace.";
    } else if (operation === "start" || operation === "stop" || operation === "keep") {
      const value = form.get("phoneId");
      if (typeof value !== "string" || !/^phone-[a-f0-9]{4,32}$/.test(value)) throw new PhoneInputError("Invalid phone ID");
      id = value;
      await phoneControl()[operation](user.id, id);
      message = operation === "keep" ? "Keep it started. The phone stops again when GitHub is available. Check Activity for progress."
        : operation === "stop" ? "Stop requested. Check Activity for progress." : "Wake requested. Check Activity for progress.";
    } else throw new PhoneInputError("Invalid phone action");
  } catch (error) {
    message = error instanceof GitHubError || error instanceof PhoneInputError || error instanceof RateLimitError
      ? redact(error.message) : "The request could not be confirmed. Refresh to check the phone before trying again.";
  }
  revalidatePath("/app");
  if (id) revalidatePath(`/app/phones/${encodeURIComponent(id)}`);
  return { message, phoneId: id };
}

export async function phoneCreationOptions() {
  const user = await requireUser();
  try {
    const machines = await phoneControl().machines(user.id, templateRepository().repository);
    return { machines, settings: userSettings(db(), user.id), message: "" };
  } catch (error) {
    return { machines: [], settings: userSettings(db(), user.id), message: error instanceof GitHubError || error instanceof PhoneInputError
      ? redact(error.message) : "Machine choices could not be loaded. Try opening New phone again." };
  }
}

export async function updateAllowance(_previous: MutationResult, form: FormData): Promise<MutationResult> {
  const user = await requireUser();
  const choice = form.get("allowance");
  if (choice === "auto") {
    clearAllowanceOverride(db(), user.id);
    revalidatePath("/app");
    revalidatePath("/app/settings/hours");
    return { message: "Automatic plan allowance restored." };
  }
  const value = choice === "custom" ? form.get("customAllowance") : choice;
  if (typeof value !== "string" || !value.trim() || !["120", "180", "custom"].includes(String(choice))) {
    return { message: "Choose Free, Pro, or a custom allowance." };
  }
  try { saveAllowance(db(), user.id, Number(value)); }
  catch { return { message: "Enter a non-negative allowance in core-hours." }; }
  revalidatePath("/app");
  return { message: "Estimated allowance updated." };
}
