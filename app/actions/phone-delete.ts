"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../lib/auth/auth";
import { asyncDb } from "../../lib/data/async-db";
import { recordAgentPhoneDeletion } from "../../lib/data/phone-deletions";
import { removePhone } from "../../lib/phone/delete-phone";
import { createPhoneDeleteApproval } from "../../lib/phone/phone-delete-approval";
import type { DeletePhoneActionResult } from "../../lib/phone/phone-delete-approval";
import { findPhone } from "../../lib/phone/phones";

export type { DeletePhoneActionResult } from "../../lib/phone/phone-delete-approval";

function refresh(phoneId: string) {
  revalidatePath("/app");
  revalidatePath(`/app/phones/${encodeURIComponent(phoneId)}`);
  revalidatePath(`/app/phones/${encodeURIComponent(phoneId)}/delete`);
}

function approvalFor(user: { id: number; authKind?: "session" | "agent" }) {
  return createPhoneDeleteApproval({
    database: asyncDb(),
    user,
    phone: findPhone,
    remove: removePhone,
    record: (userId, phoneName, agentKeyId) => recordAgentPhoneDeletion(asyncDb(), { userId, phoneName, agentKeyId }),
  });
}

/** Session-only approval. The agent that asked can only poll the result. */
export async function approvePhoneDelete(_previous: DeletePhoneActionResult,
  form: FormData): Promise<DeletePhoneActionResult> {
  const user = await requireUser();
  const result = await approvalFor(user).approve(form.get("request"), form.get("confirmation"));
  if (result.phoneId) refresh(result.phoneId);
  return result;
}

/** Keep it. A denial cannot be undone by the agent. */
export async function denyPhoneDelete(_previous: DeletePhoneActionResult,
  form: FormData): Promise<DeletePhoneActionResult> {
  const user = await requireUser();
  const result = await approvalFor(user).deny(form.get("request"));
  if (result.phoneId) refresh(result.phoneId);
  return result;
}
