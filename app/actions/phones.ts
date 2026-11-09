"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "../../lib/auth/auth";
import { phoneControl, templateRepository } from "../../lib/phone/phone-control";
import { PHONE_MACHINE } from "../../lib/github/github";
import { IDLE_MAX, IDLE_MIN, parseIdle } from "../../lib/shared/idle";
import { GitHubError } from "../../lib/github/github";
import { PhoneInputError, redact } from "../../lib/phone/phone-mutations";
import { PHONE_ID } from "../../lib/shared/phone-name";
import { RateLimitError } from "../../lib/data/rate-limit";
import { asyncDb } from "../../lib/data/async-db";
import { saveAllowance, userSettings } from "../../lib/data/usage";
import { clearAllowanceOverride } from "../../lib/data/settings";
import { AGENT_DELETE_PHONE_MESSAGE, AGENT_SETTINGS_MESSAGE } from "../../lib/auth/scope";

// `refused`: GitHub rejected a new codespace, often because of its own codespace limit.
type MutationResult = { message: string; phoneId?: string; refused?: boolean };

export async function mutatePhone(_previous: MutationResult, form: FormData): Promise<MutationResult> {
  const user = await requireUser();
  const operation = form.get("operation");
  if (user.authKind === "agent" && operation === "delete") return { message: AGENT_DELETE_PHONE_MESSAGE };
  let id: string | undefined;
  let message: string;
  let deleted = false;
  let refused = false;
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
    } else if (operation === "start" || operation === "stop" || operation === "keep" || operation === "retryBoot") {
      const value = form.get("phoneId");
      if (typeof value !== "string" || !PHONE_ID.test(value)) throw new PhoneInputError("Invalid phone ID");
      id = value;
      await phoneControl()[operation](user.id, id);
      message = operation === "retryBoot" ? "Android boot requested." : operation === "keep" ? "Keep it started. The phone stops again when GitHub is available. Check Activity for progress."
        : operation === "stop" ? "Stop requested. Check Activity for progress." : "Wake requested. Check Activity for progress.";
    } else if (operation === "delete") {
      const value = form.get("phoneId");
      if (typeof value !== "string" || !PHONE_ID.test(value)) throw new PhoneInputError("Invalid phone ID");
      if (form.get("confirmation") !== value) throw new PhoneInputError("Type the phone name to confirm.");
      await phoneControl().remove(user.id, value);
      deleted = true;
      message = "Phone deleted.";
    } else throw new PhoneInputError("Invalid phone action");
  } catch (error) {
    if (!(error instanceof GitHubError || error instanceof PhoneInputError || error instanceof RateLimitError)) console.error("phone action failed", operation, error);
    refused = operation === "create" && error instanceof GitHubError;
    message = error instanceof GitHubError || error instanceof PhoneInputError || error instanceof RateLimitError
      ? redact(error.message) : "The request could not be confirmed. Refresh to check the phone before trying again.";
  }
  revalidatePath("/app");
  if (deleted) redirect("/app");
  if (id) revalidatePath(`/app/phones/${encodeURIComponent(id)}`);
  return { message, phoneId: id, refused };
}

export async function phoneCreationOptions() {
  const user = await requireUser();
  try {
    const machines = await phoneControl().machines(user.id, templateRepository().repository);
    return { machines, settings: await userSettings(asyncDb(), user.id), message: "" };
  } catch (error) {
    return { machines: [], settings: await userSettings(asyncDb(), user.id), message: error instanceof GitHubError || error instanceof PhoneInputError
      ? redact(error.message) : "Machine choices could not be loaded. Try opening New phone again." };
  }
}

export async function updateAllowance(_previous: MutationResult, form: FormData): Promise<MutationResult> {
  const user = await requireUser();
  if (user.authKind === "agent") return { message: AGENT_SETTINGS_MESSAGE };
  const choice = form.get("allowance");
  if (choice === "auto") {
    await clearAllowanceOverride(asyncDb(), user.id);
    revalidatePath("/app");
    revalidatePath("/app/settings/hours");
    return { message: "Automatic plan allowance restored." };
  }
  const value = choice === "custom" ? form.get("customAllowance") : choice;
  if (typeof value !== "string" || !value.trim() || !["120", "180", "custom"].includes(String(choice))) {
    return { message: "Choose Free, Pro, or a custom allowance." };
  }
  try { await saveAllowance(asyncDb(), user.id, Number(value)); }
  catch { return { message: "Enter a non-negative allowance in core-hours." }; }
  revalidatePath("/app");
  return { message: "Estimated allowance updated." };
}
