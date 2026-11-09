"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../lib/auth/auth";
import { AGENT_SETTINGS_MESSAGE } from "../../lib/auth/scope";
import { asyncDb } from "../../lib/data/async-db";
import { revokeAgentKey as revoke, revokeAllAgentKeys as revokeAll } from "../../lib/data/agents";
import { updateSettings } from "../../lib/data/settings";

/** Connected agents are managed only from a browser session, never from an agent key. */
export async function revokeAgentKey(id: unknown) {
  const user = await requireUser();
  if (user.authKind === "agent") return { ok: false, message: AGENT_SETTINGS_MESSAGE };
  if (!Number.isSafeInteger(id) || Number(id) < 1) return { ok: false, message: "Choose an agent to revoke." };
  const changed = await revoke(asyncDb(), user.id, Number(id));
  revalidatePath("/app/settings/agents");
  return { ok: true, message: changed ? "Agent revoked." : "That agent was already revoked." };
}

export async function revokeAllAgentKeys() {
  const user = await requireUser();
  if (user.authKind === "agent") return { ok: false, message: AGENT_SETTINGS_MESSAGE };
  const changed = await revokeAll(asyncDb(), user.id);
  revalidatePath("/app/settings/agents");
  return { ok: true, message: changed ? `Revoked ${changed} ${changed === 1 ? "agent" : "agents"}.` : "No active agents to revoke." };
}

/** A switch only the browser session may flip. Agent keys cannot change it. */
export async function saveAgentDeletePhones(value: unknown) {
  const user = await requireUser();
  if (user.authKind === "agent") return { ok: false, message: AGENT_SETTINGS_MESSAGE };
  if (typeof value !== "boolean") return { ok: false, message: "Choose On or Off." };
  try {
    await updateSettings(asyncDb(), user.id, { agent_delete_phones: value });
    revalidatePath("/app/settings/agents");
    return { ok: true, message: value ? "Agents can delete phones without asking." : "Agents need your approval to delete a phone." };
  } catch {
    return { ok: false, message: "Settings could not be saved. Try again." };
  }
}
