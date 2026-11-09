"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../lib/auth/auth";
import { AGENT_SETTINGS_MESSAGE } from "../../lib/auth/scope";
import { asyncDb } from "../../lib/data/async-db";
import { revokeAgentKey as revoke, revokeAllAgentKeys as revokeAll } from "../../lib/data/agents";

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
